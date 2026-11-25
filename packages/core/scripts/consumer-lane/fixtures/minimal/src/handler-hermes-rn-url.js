/**
 * Faithful model of React Native 0.88 `Libraries/Blob/URL.js` + `URLSearchParams.js`:
 * - No `URL.canParse`.
 * - `pathname` matches only `http(s)://` URLs (custom schemes return `'/'`).
 * - `URLSearchParams` decodes via raw `decodeURIComponent` without try/catch,
 *   throwing `URIError` on malformed `%` escapes.
 *
 * Shared by both the Level-1 `node:vm` RN realm tests (`tests/rn-realm/rn-realm.ts`)
 * and the real Hermes V1 VM consumer proof (`handler-hermes.mjs`).
 */
((g) => {
  const validateBaseUrl = (url) => /^https?:\/\//.test(url);

  class RnURLSearchParams {
    constructor(params) {
      this._searchParams = new Map();
      if (params === null || params === undefined) return;
      if (typeof params === 'string') {
        for (const pair of params.replace(/^\?/, '').split('&')) {
          if (!pair) continue;
          const parts = pair
            .split('=')
            .map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
          this.append(parts[0] ?? '', parts[1] ?? '');
        }
      } else if (Array.isArray(params)) {
        for (const [key, value] of params) this.append(key, value);
      } else if (typeof params === 'object') {
        for (const [key, value] of Object.entries(params)) this.append(key, value);
      }
    }
    get size() {
      return this._searchParams.size;
    }
    append(key, value) {
      const k = String(key);
      const v = String(value);
      if (!this._searchParams.has(k)) this._searchParams.set(k, [v]);
      else this._searchParams.get(k).push(v);
    }
    delete(name) {
      this._searchParams.delete(name);
    }
    get(name) {
      const values = this._searchParams.get(name);
      return values ? values[0] : null;
    }
    getAll(name) {
      return this._searchParams.get(name) ?? [];
    }
    has(name) {
      return this._searchParams.has(name);
    }
    keys() {
      return this._searchParams.keys();
    }
    entries() {
      const out = [];
      for (const [k, vals] of this._searchParams.entries()) {
        for (const v of vals) out.push([k, v]);
      }
      return out[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      const out = [];
      for (const [k, vals] of this._searchParams.entries()) {
        for (const v of vals) out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
      return out.join('&');
    }
  }

  class RnURL {
    constructor(url, base) {
      this._searchParamsInstance = null;
      if (!base) {
        if (typeof url !== 'string' || !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url)) {
          throw new TypeError(`Invalid URL: ${String(url)}`);
        }
        this._url = url;
        if (validateBaseUrl(this._url)) {
          const after = this._url.split('://')[1];
          if (after && !after.includes('/')) this._url += '/';
        }
      } else {
        const baseUrl = typeof base === 'string' ? base : String(base);
        if (!validateBaseUrl(baseUrl)) throw new TypeError(`Invalid base URL: ${baseUrl}`);
        if (/^https?:\/\//.test(String(url))) {
          this._url = String(url);
        } else {
          const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
          let path = String(url);
          if (!path.startsWith('/')) path = `/${path}`;
          this._url = `${trimmedBase}${path}`;
        }
      }
    }
    get protocol() {
      const m = this._url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
      return m ? `${m[1]}:` : '';
    }
    get host() {
      const hm = this._url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
      const pm = this._url.match(/:(\d+)(?=[/?#]|$)/);
      return hm ? `${hm[1]}${pm ? `:${pm[1]}` : ''}` : '';
    }
    get hostname() {
      const m = this._url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
      return m ? m[1] : '';
    }
    get port() {
      const m = this._url.match(/:(\d+)(?=[/?#]|$)/);
      return m ? m[1] : '';
    }
    get origin() {
      const m = this._url.match(/^(https?:\/\/[^/]+)/);
      return m ? m[1] : '';
    }
    get pathname() {
      const m = this._url.match(/https?:\/\/[^/]+(\/[^?#]*)?/);
      return m ? m[1] || '/' : '/';
    }
    get search() {
      const m = this._url.match(/\?([^#]*)/);
      return m ? `?${m[1]}` : '';
    }
    get hash() {
      const m = this._url.match(/#([^/]*)/);
      return m ? `#${m[1]}` : '';
    }
    get href() {
      return this.toString();
    }
    get searchParams() {
      if (this._searchParamsInstance === null) {
        this._searchParamsInstance = new RnURLSearchParams(this.search);
      }
      return this._searchParamsInstance;
    }
    toString() {
      return this._url;
    }
  }

  g.URL = RnURL;
  g.URLSearchParams = RnURLSearchParams;
})(globalThis);
