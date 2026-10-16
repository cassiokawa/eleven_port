import { createRoot } from "react-dom/client";
import { configurePdfWorker } from "@eleven-port/core";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { App } from "./App";

// pdf.js needs its worker script URL in the browser; Vite emits the file and gives us its URL.
configurePdfWorker(pdfWorkerUrl);

createRoot(document.getElementById("root")!).render(<App />);
