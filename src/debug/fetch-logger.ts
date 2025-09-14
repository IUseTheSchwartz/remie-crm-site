// src/debug/fetch-logger.ts
export function enableFetchLogging() {
  if ((window as any).__remieFetchPatched) return;
  (window as any).__remieFetchPatched = true;

  const orig = window.fetch.bind(window);
  const cloneWithUrl = (req: Request, url: string) =>
    new Request(url, { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : req.body });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : (input as Request).url;
    const isFn = url.includes('/.netlify/functions/');
    const isMsg = url.includes('/.netlify/functions/messages-send');
    if (isMsg && !url.includes('debug=')) {
      const sep = url.includes('?') ? '&' : '?';
      const newUrl = url + sep + 'debug=1';
      input = typeof input === 'string' ? newUrl : cloneWithUrl(input as Request, newUrl);
      url = newUrl;
    }
    const res = await orig(input as any, init);
    const text = await res.clone().text();
    let json: any = null; try { json = JSON.parse(text); } catch {}
    if (isFn) {
      console.groupCollapsed(`🛰️ ${res.status} ${url}`);
      console.log('response', json || text);
      console.groupEnd();
    }
    return res;
  };
}
