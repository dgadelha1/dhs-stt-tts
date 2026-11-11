/**
 * DOM mínimo (e honesto) para carregar os bundles de cliente DSH fora do
 * navegador. Não é um navegador: cobre o que os plugins usam no `apply()`
 * (injeção de <style data-plugin>) e stubs defensivos para o que só roda em
 * handlers/efeitos do React (mediaDevices, Audio, localStorage, observers).
 *
 * Tudo é hostil a crash acidental: métodos devolvem valores neutros e
 * registram chamadas quando útil.
 */

class FakeNode {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._listeners = new Map();
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((name) => self._toggleClass(name, true)),
      remove: (...names) => names.forEach((name) => self._toggleClass(name, false)),
      toggle: (name, force) => {
        const present = self._classes().has(name);
        const next = typeof force === 'boolean' ? force : !present;
        self._toggleClass(name, next);
        return next;
      },
      contains: (name) => self._classes().has(name),
      replace: () => {},
      toString: () => self.className,
    };
  }

  _classes() {
    return new Set(String(this.className || '').split(/\s+/).filter(Boolean));
  }

  _toggleClass(name, on) {
    const classes = this._classes();
    if (on) classes.add(name);
    else classes.delete(name);
    this.className = [...classes].join(' ');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    child.parentNode = this;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    if (child) child.parentNode = null;
    return child;
  }

  replaceChild(next, previous) {
    const index = this.childNodes.indexOf(previous);
    if (index >= 0) {
      this.childNodes[index] = next;
      next.parentNode = this;
      if (previous) previous.parentNode = null;
    }
    return previous;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains?.(node));
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this._listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    const type = event?.type;
    if (type && this._listeners.has(type)) {
      for (const listener of this._listeners.get(type)) {
        try {
          listener.call(this, event);
        } catch {
          /* efeito de teste: não propagar */
        }
      }
    }
    if (type) this[`on${type}`]?.(event);
    return true;
  }

  click() {
    return this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
  }

  focus() {}
  blur() {}
  scrollIntoView() {}
  setSelectionRange() {}
  select() {}
  animate() {
    return { cancel() {}, finished: Promise.resolve() };
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSimpleSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return querySelectorAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return querySelectorAll(this, selector);
  }

  get elements() {
    return this.childNodes;
  }
}

function parseCompound(selector) {
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = selector.trim();
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)?/.exec(rest);
  if (tagMatch && tagMatch[1]) {
    compound.tag = tagMatch[1].toUpperCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const tokenRe = /(?:\.([\w-]+))|(?:#([\w-]+))|(?:\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\])/g;
  let match;
  while ((match = tokenRe.exec(rest))) {
    if (match[1]) compound.classes.push(match[1]);
    else if (match[2]) compound.id = match[2];
    else if (match[3]) {
      compound.attrs.push({ name: match[3], value: match[4] ?? match[5] ?? match[6] ?? null });
    }
  }
  return compound;
}

function matchesCompound(node, compound) {
  if (!node || node.nodeType !== 1) return false;
  if (compound.tag && node.tagName !== compound.tag) return false;
  if (compound.id && node.id !== compound.id) return false;
  const classes = node._classes?.() ?? new Set();
  for (const className of compound.classes) if (!classes.has(className)) return false;
  for (const attr of compound.attrs) {
    if (!node.hasAttribute(attr.name)) return false;
    if (attr.value !== null && node.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function matchesSimpleSelector(node, selector) {
  // Suporta apenas seletores simples/compostos e descendência por espaço.
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  let current = node;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const compound = parseCompound(parts[index]);
    let matchedNode = null;
    let candidate = current;
    while (candidate) {
      if (matchesCompound(candidate, compound)) {
        matchedNode = candidate;
        break;
      }
      candidate = candidate.parentNode;
    }
    if (!matchedNode) return false;
    current = matchedNode.parentNode;
  }
  return true;
}

function querySelectorAll(root, selector) {
  const groups = String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const results = [];
  const visit = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (groups.some((group) => matchesSimpleSelector(node, group))) results.push(node);
    for (const child of node.childNodes) visit(child);
  };
  // document: inclui head/body/documentElement
  if (root === documentStub) {
    visit(root.documentElement);
    visit(root.head);
    visit(root.body);
    return dedupe(results);
  }
  for (const child of root.childNodes) visit(child);
  return dedupe(results);
}

function dedupe(nodes) {
  return nodes.filter((node, index) => nodes.indexOf(node) === index);
}

const documentStub = new FakeNode('document', null);
documentStub.nodeType = 9;
documentStub.documentElement = new FakeNode('html', documentStub);
documentStub.head = new FakeNode('head', documentStub);
documentStub.body = new FakeNode('body', documentStub);
documentStub.documentElement.appendChild(documentStub.head);
documentStub.documentElement.appendChild(documentStub.body);
documentStub.readyState = 'complete';
documentStub.title = '';
documentStub.cookie = '';
documentStub.hidden = false;
documentStub.visibilityState = 'visible';
documentStub.createElement = (tag) => new FakeNode(tag, documentStub);
documentStub.createElementNS = (namespace, tag) => new FakeNode(tag, documentStub);
documentStub.createTextNode = (text) => {
  const node = new FakeNode('#text', documentStub);
  node.nodeType = 3;
  node.textContent = String(text);
  return node;
};
documentStub.createDocumentFragment = () => new FakeNode('#fragment', documentStub);
documentStub.getElementById = (id) => documentStub.querySelector(`#${id}`);
documentStub.getElementsByTagName = (tag) => documentStub.querySelectorAll(tag);
documentStub.getElementsByClassName = (className) => documentStub.querySelectorAll(`.${className}`);
documentStub.querySelector = (selector) => querySelectorAll(documentStub, selector)[0] ?? null;
documentStub.querySelectorAll = (selector) => querySelectorAll(documentStub, selector);
documentStub.addEventListener = () => {};
documentStub.removeEventListener = () => {};
documentStub.dispatchEvent = () => true;
documentStub.hasFocus = () => true;
documentStub.getSelection = () => ({ toString: () => '', removeAllRanges() {}, addRange() {} });

class FakeObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.mimeType = options.mimeType ?? 'audio/webm';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    try {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([82, 73, 70, 70])]) });
    } catch {
      /* noop */
    }
    try {
      this.onstop?.();
    } catch {
      /* noop */
    }
  }

  pause() {}
  resume() {}
  requestData() {}
  addEventListener() {}
  removeEventListener() {}
}

class FakeAudioNode {
  constructor() {
    this.gain = { value: 1 };
    this.frequency = { value: 440 };
    this._onended = null;
  }

  connect() {
    return this;
  }

  disconnect() {}
  start() {
    setTimeout(() => this.onended?.(), 0);
  }

  stop() {
    this.onended?.();
  }

  get onended() {
    return this._onended;
  }

  set onended(handler) {
    this._onended = handler;
  }
}

function createLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
    removeItem: (key) => {
      store.delete(String(key));
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    _dump: () => Object.fromEntries(store),
  };
}

/**
 * Cria o sandbox de `window`/`document` e executa o bundle de cliente dentro
 * de um contexto vm, capturando `__ModuleLoader__.load`.
 *
 * @param {{filePath: string, filename?: string, deps?: Record<string, any>, timeoutMs?: number}} options
 */
export async function loadClientBundle(options) {
  const fs = await import('node:fs');
  const vm = await import('node:vm');

  const code = fs.readFileSync(options.filePath, 'utf8');
  const loaded = [];
  const sandbox = createSandbox();
  sandbox.window.__ModuleLoader__ = {
    load: (entry) => {
      loaded.push(entry);
      return entry;
    },
  };
  const context = vm.createContext(sandbox, {
    name: options.filename ?? 'client-bundle',
    codeGeneration: { strings: true, wasm: false },
  });
  vm.runInContext(code, context, {
    filename: options.filename ?? options.filePath,
    timeout: options.timeoutMs ?? 20000,
  });
  if (loaded.length !== 1) {
    throw new Error(`__ModuleLoader__.load deveria ser chamado exatamente 1x; foi ${loaded.length}x`);
  }
  const entry = loaded[0];
  if (typeof entry.factory !== 'function') throw new Error('__ModuleLoader__.load sem factory');
  const deps = options.deps ?? {};
  const requireFn = (id) => {
    if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
    throw new Error(`require("${id}") inesperado no bundle do cliente (permitidos: ${Object.keys(deps).join(', ') || 'nenhum'})`);
  };
  const exported = entry.factory(requireFn);
  return { entry, exports: exported, sandbox, context };
}

/** Monta o sandbox completo (window === sandbox, com stubs do navegador). */
export function createSandbox() {
  const localStorage = createLocalStorage();
  const location = {
    href: 'http://127.0.0.1:3099/',
    origin: 'http://127.0.0.1:3099',
    protocol: 'http:',
    host: '127.0.0.1:3099',
    hostname: '127.0.0.1',
    port: '3099',
    pathname: '/',
    search: '',
    hash: '',
    reload() {},
    assign() {},
    replace() {},
  };
  const matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
  });

  const sandbox = {
    console: {
      log: (...args) => console.log('[page]', ...args),
      info: (...args) => console.info('[page]', ...args),
      warn: (...args) => console.warn('[page]', ...args),
      error: (...args) => console.error('[page]', ...args),
      debug: () => {},
      trace: () => {},
      group: () => {},
      groupEnd: () => {},
      time: () => {},
      timeEnd: () => {},
    },
    document: documentStub,
    navigator: {
      language: 'pt-BR',
      languages: ['pt-BR', 'en-US'],
      userAgent: 'dsh-voice-qa-smoke',
      platform: 'Win32',
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
          getAudioTracks: () => [{ stop() {}, getSettings: () => ({ deviceId: 'qa' }) }],
        }),
        enumerateDevices: async () => [{ deviceId: 'qa', kind: 'audioinput', label: 'QA Mic' }],
        addEventListener() {},
        removeEventListener() {},
      },
      clipboard: { writeText: async () => {} },
      onLine: true,
    },
    location,
    history: { pushState() {}, replaceState() {}, back() {}, forward() {}, length: 1, state: null },
    localStorage,
    sessionStorage: createLocalStorage(),
    matchMedia,
    getComputedStyle: (node) => ({
      getPropertyValue: (property) => (node?.style?.[property] ?? ''),
    }),
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    performance: { now: () => Date.now(), mark() {}, measure() {}, clearMarks() {} },
    crypto: {
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      getRandomValues: (array) => array,
    },
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    TextEncoder,
    TextDecoder,
    Blob,
    File: typeof File !== 'undefined' ? File : Blob,
    URL: Object.assign(URL, {
      createObjectURL: () => 'blob:qa-fake',
      revokeObjectURL: () => {},
    }),
    Event: class FakeEvent {
      constructor(type) {
        this.type = type;
        this.target = null;
        this.defaultPrevented = false;
      }

      preventDefault() {
        this.defaultPrevented = true;
      }

      stopPropagation() {}
    },
    CustomEvent: class FakeCustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }

      preventDefault() {}
      stopPropagation() {}
    },
    KeyboardEvent: class FakeKeyboardEvent {
      constructor(type, init = {}) {
        Object.assign(this, init);
        this.type = type;
      }

      preventDefault() {}
      stopPropagation() {}
    },
    MouseEvent: class FakeMouseEvent {
      constructor(type, init = {}) {
        Object.assign(this, init);
        this.type = type;
      }

      preventDefault() {}
      stopPropagation() {}
    },
    HTMLElement: FakeNode,
    Element: FakeNode,
    Node: FakeNode,
    EventTarget: class {
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
    },
    ResizeObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    MutationObserver: FakeObserver,
    MediaRecorder: FakeMediaRecorder,
    MediaStream: class {
      getTracks() {
        return [];
      }
    },
    Audio: class FakeAudio {
      constructor(src = '') {
        this.src = src;
        this.currentTime = 0;
        this.duration = 1;
        this.paused = true;
        this.volume = 1;
        this.playbackRate = 1;
        this.onended = null;
        this.onerror = null;
      }

      play() {
        this.paused = false;
        setTimeout(() => this.onended?.(), 0);
        return Promise.resolve();
      }

      pause() {
        this.paused = true;
      }

      load() {}
      removeAttribute() {}
      addEventListener() {}
      removeEventListener() {}
    },
    AudioContext: class FakeAudioContext {
      constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = new FakeAudioNode();
        this.sampleRate = 48000;
      }

      createAnalyser() {
        const node = new FakeAudioNode();
        node.fftSize = 256;
        node.frequencyBinCount = 128;
        node.getByteTimeDomainData = (array) => array.fill(128);
        node.getByteFrequencyData = (array) => array.fill(0);
        return node;
      }

      createMediaStreamSource() {
        return new FakeAudioNode();
      }

      createScriptProcessor() {
        return new FakeAudioNode();
      }

      createGain() {
        return new FakeAudioNode();
      }

      close() {
        return Promise.resolve();
      }

      decodeAudioData() {
        return Promise.resolve({ duration: 1, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000) });
      }
    },
    OfflineAudioContext: class FakeOfflineAudioContext {
      constructor(channels, length, sampleRate) {
        this.channels = channels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.destination = new FakeAudioNode();
      }

      startRendering() {
        return Promise.resolve({
          duration: this.length / this.sampleRate,
          sampleRate: this.sampleRate,
          numberOfChannels: this.channels,
          getChannelData: () => new Float32Array(this.length),
        });
      }
    },
    speechSynthesis: {
      getVoices: () => [
        { name: 'QA Voice', lang: 'pt-BR', default: true, localService: true },
        { name: 'QA Voice EN', lang: 'en-US', default: false, localService: true },
      ],
      speak: () => {},
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
    },
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    origin: 'http://127.0.0.1:3099',
    name: 'dsh-voice-qa',
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    scrollTo() {},
    alert() {},
    confirm: () => true,
    prompt: () => null,
    fetch: () => Promise.reject(new Error('fetch não é permitido no smoke de cliente (tudo via RPC)')),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  return sandbox;
}

export { FakeNode, createLocalStorage };
