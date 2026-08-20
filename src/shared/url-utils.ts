(() => {
  'use strict';

  function cleanUrl(url: string): string {
    if (!url) return url;
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}${urlObj.search}`;
    } catch {
      return url.split('#')[0];
    }
  }

  function extractJsUrlFromStack(stack?: string, fullstack?: string[]): string | null {
    const stackLines = fullstack || (stack ? [stack] : []);

    for (const line of stackLines) {
      if (typeof line !== 'string') {
        continue;
      }

      const urlMatch = line.match(/\(https?:\/\/[^)]+\)/g);
      if (urlMatch) {
        for (const match of urlMatch) {
          let url = match.slice(1, -1);
          url = url.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
          url = cleanUrl(url);
          if (url) {
            return url;
          }
        }
      }

      const bareUrlMatch = line.match(/https?:\/\/[^\s)]+/g);
      if (bareUrlMatch) {
        for (const match of bareUrlMatch) {
          let url = match;
          url = url.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
          url = cleanUrl(url);
          if (url) {
            return url;
          }
        }
      }
    }

    return null;
  }

  type FransceiverUrlUtilsType = {
    cleanUrl: typeof cleanUrl;
    extractJsUrlFromStack: typeof extractJsUrlFromStack;
  };

  const globalObj = globalThis as typeof globalThis & {
    FransceiverUrlUtils?: Partial<FransceiverUrlUtilsType>;
  };

  globalObj.FransceiverUrlUtils = Object.assign(globalObj.FransceiverUrlUtils || {}, {
    cleanUrl,
    extractJsUrlFromStack
  });
})();
