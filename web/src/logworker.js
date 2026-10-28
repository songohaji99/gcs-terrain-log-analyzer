// Web Worker: parse + normalisasi + downsampling flight log di luar thread UI.
import { parseLogFile } from './logparse.js';

self.onmessage = ({ data: { id, name, buf } }) => {
  try {
    const model = parseLogFile(name, buf, { onProgress: (f) => self.postMessage({ id, progress: f }) });
    const transfer = Object.values(model.streams).flatMap((s) => Object.values(s).map((a) => a.buffer));
    self.postMessage({ id, model }, transfer);
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};
