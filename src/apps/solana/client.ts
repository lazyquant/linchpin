/** The page's entry: it reads the data block of its own document and starts the app with the browser's globals. */
import { readData, startApp } from "./app";

const data = readData(document);
if (data) {
  startApp({
    document,
    location,
    addEventListener: (type, handler) => window.addEventListener(type, handler),
    sessionStorage: (() => {
      try {
        return window.sessionStorage;
      } catch {
        return undefined;
      }
    })(),
    fetch: data.mode === "served" ? (input, init) => window.fetch(input, init) : undefined,
    data,
  });
}
