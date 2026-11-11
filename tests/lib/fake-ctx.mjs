/**
 * Contextos falsos do Cordis/DSH para os testes de servidor e de cliente.
 *
 * Objetivo: ser fiel ao contrato (seção 3) mas simples, expondo o que os
 * plugins realmente usam e registrando tudo para asserção.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;

function makeTranslate(dictionaries, namespace) {
  return (key, params) => {
    const dict = dictionaries.get(namespace) ?? dictionaries.values().next().value ?? {};
    const table = dict.pt ?? dict.en ?? {};
    let value = table[key] ?? dict.en?.[key] ?? key;
    if (params && typeof value === 'string') {
      value = value.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? `{${name}}` : String(params[name])));
    }
    return value;
  };
}

function makeChatSource() {
  return {
    subscribe() {
      return () => {};
    },
    getSnapshot() {
      return {
        timeline: { turnOrder: [] },
        locations: { getTurn: () => [] },
        nodes: { get: () => null },
      };
    },
  };
}

/** Contexto de cliente (metade `client.js`). */
export function createClientCtx(options = {}) {
  const slots = [];
  const dictionaries = new Map();
  const effectLabels = [];
  const effectDisposers = [];
  const rpcCalls = [];
  const unknownApi = new Set();
  const warnings = [];
  const logs = [];
  let disposed = false;

  const uiSession = {
    materialize() {
      return { hooks: { chat: makeChatSource() } };
    },
  };

  const ctx = {
    effect(fn, label) {
      effectLabels.push(String(label ?? ''));
      const result = fn();
      const dispose = typeof result === 'function' ? result : () => {};
      effectDisposers.push(dispose);
      return dispose;
    },
    slots: {
      register(entry, Component) {
        if (disposed) throw new Error('slots.register após dispose');
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
          throw new Error('slots.register exige um objeto com name (string)');
        }
        const record = { entry, Component, slotName: entry.name };
        slots.push(record);
        return () => {
          const index = slots.indexOf(record);
          if (index >= 0) slots.splice(index, 1);
        };
      },
      inject(slotName, register) {
        if (typeof register !== 'function') throw new Error('slots.inject exige register');
        const dispose = register();
        return typeof dispose === 'function' ? dispose : () => {};
      },
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries.set(namespace, dictionary);
        return () => dictionaries.delete(namespace);
      },
      bind(namespace) {
        return makeTranslate(dictionaries, namespace);
      },
      t(key, params) {
        return makeTranslate(dictionaries, undefined)(key, params);
      },
      getSnapshot() {
        return { revision: 1, value: {} };
      },
      subscribe() {
        return () => {};
      },
    },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          rpcCalls.push({ channel, endpoint, payload });
          return { ok: true, value: { qa: true } };
        },
        handle() {
          return () => {};
        },
      },
      register() {
        return () => {};
      },
      state: { getSnapshot: () => ({ connected: true }), subscribe: () => () => {} },
    },
    sessions: {
      binding(sessionId) {
        return { id: sessionId ?? 'qa-session' };
      },
      list() {
        return [];
      },
    },
    uiSession,
    get(name) {
      if (name === 'uiSession') return uiSession;
      if (name === 'connection') return ctx.connection;
      if (name === 'slots') return ctx.slots;
      if (name === 'locale') return ctx.locale;
      if (name === 'sessions') return ctx.sessions;
      return undefined;
    },
    on() {
      return () => {};
    },
    off() {},
    emit() {},
    set() {},
    logger: {
      debug: (...args) => logs.push(['debug', args.map(String).join(' ')]),
      info: (...args) => logs.push(['info', args.map(String).join(' ')]),
      warn: (...args) => {
        logs.push(['warn', args.map(String).join(' ')]);
        warnings.push(args.map(String).join(' '));
      },
      error: (...args) => {
        logs.push(['error', args.map(String).join(' ')]);
        warnings.push(args.map(String).join(' '));
      },
    },
  };

  const proxy = new Proxy(ctx, {
    get(target, property) {
      if (property === 'then') return undefined;
      if (property in target) return target[property];
      if (typeof property !== 'string') return undefined;
      unknownApi.add(property);
      if (options.strictUnknown !== false) {
        throw new Error(`ctx.${property} não existe no contexto falso de cliente (API fora do contrato §3.4)`);
      }
      return undefined;
    },
  });

  return {
    ctx: proxy,
    slots,
    dictionaries,
    effectLabels,
    rpcCalls,
    warnings,
    logs,
    unknownApi,
    get disposed() {
      return disposed;
    },
    /** Despacha todos os efeitos em ordem inversa (como o Cordis faria). */
    disposeAll() {
      if (disposed) return;
      disposed = true;
      for (const dispose of [...effectDisposers].reverse()) {
        try {
          dispose();
        } catch (error) {
          warnings.push(`dispose falhou: ${error.message}`);
        }
      }
    },
    /** t() do namespace declarado no dicionário registrado. */
    translate(namespace) {
      return makeTranslate(dictionaries, namespace);
    },
  };
}

/** Contexto de servidor (metade `index.js`). */
export function createServerCtx(options = {}) {
  const channels = new Map();
  const effects = [];
  const webRoutes = [];
  const logs = [];
  const warnings = [];
  const services = new Map();
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-server-'));
  const disposers = [];

  function registerChannel(channel, handler) {
    if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) {
      throw new Error(`canal RPC inválido: ${JSON.stringify(channel)} (padrão ${CHANNEL_PATTERN})`);
    }
    if (typeof handler !== 'function') throw new Error('handler RPC não é função');
    if (channels.has(channel)) throw new Error(`canal RPC já registrado: ${channel}`);
    channels.set(channel, handler);
    return () => channels.delete(channel);
  }

  const ctx = {
    effect(fn, label) {
      effects.push(String(label ?? ''));
      const result = fn();
      const dispose = typeof result === 'function' ? result : () => {};
      disposers.push(dispose);
      return dispose;
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          return registerChannel(channel, handler);
        },
        register() {
          return () => {};
        },
      },
      register(_ctx, channel, handler) {
        // fallback legítimo quando connection.rpc.handle exige webServer injetado
        return registerChannel(channel, handler);
      },
    },
    webServer: {
      register(route, handler) {
        webRoutes.push({ route, handler });
        return () => {};
      },
      get() {},
    },
    get(name) {
      if (name === 'connection') return ctx.connection;
      if (name === 'webServer') return ctx.webServer;
      return services.get(name);
    },
    provide(name, value) {
      services.set(name, value);
    },
    set(name, value) {
      services.set(name, value);
    },
    on() {
      return () => {};
    },
    off() {},
    emit() {},
    logger: {
      debug: (...args) => logs.push(['debug', args.map(String).join(' ')]),
      info: (...args) => logs.push(['info', args.map(String).join(' ')]),
      warn: (...args) => {
        logs.push(['warn', args.map(String).join(' ')]);
        warnings.push(args.map(String).join(' '));
      },
      error: (...args) => {
        logs.push(['error', args.map(String).join(' ')]);
        warnings.push(args.map(String).join(' '));
      },
    },
    dataDir,
    config: options.config ?? {},
  };

  return {
    ctx,
    channels,
    webRoutes,
    effects,
    logs,
    warnings,
    dataDir,
    services,
    /** Simula a versão em que `rpc.handle` exige injeção de webServer (0.2.2-rc.1). */
    simulateInjectBug() {
      const original = ctx.connection.rpc.handle;
      ctx.connection.rpc.handle = () => {
        throw new Error('cannot get property "webServer" without inject');
      };
      return () => {
        ctx.connection.rpc.handle = original;
      };
    },
    disposeAll() {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch (error) {
          warnings.push(`dispose falhou: ${error.message}`);
        }
      }
    },
  };
}
