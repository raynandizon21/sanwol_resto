// Opens the browser's print screen for a built PDF, with no download and no in-app preview: the
// file is loaded into a hidden frame and printed from there. The frame stays until the next print
// (removing it right away would cancel the print screen in some browsers). If the browser won't
// print a PDF from a frame (some mobile browsers), the file opens in a new tab to print from there.

let frame: HTMLIFrameElement | null = null;
let frameUrl: string | null = null;

const cleanup = () => {
  frame?.remove();
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frame = null;
  frameUrl = null;
};

export function printPdf(blob: Blob): Promise<void> {
  cleanup();
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  // Not display:none: the browser has to load the PDF viewer for print() to work.
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  frame = iframe;
  frameUrl = url;

  return new Promise((resolve) => {
    const fallback = () => {
      window.open(url, '_blank', 'noopener');
      resolve();
    };
    iframe.onload = () => {
      // A moment for the PDF viewer inside the frame to be ready.
      window.setTimeout(() => {
        try {
          const win = iframe.contentWindow;
          if (!win) return fallback();
          win.focus();
          win.print();
          resolve();
        } catch {
          fallback();
        }
      }, 250);
    };
    iframe.src = url;
    document.body.appendChild(iframe);
  });
}
