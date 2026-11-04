import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// No additional npm dependency: use an installed Chromium, or set CHROME_BIN.
// CI can require this check with CHROME_BIN=/path/to/chrome npm test.
const chrome = process.env.CHROME_BIN || ["chromium", "chromium-browser", "google-chrome"]
  .find((candidate) => spawnSync(candidate, ["--version"]).status === 0);
const site = new URL("../site/", import.meta.url);

const fixture = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/css/style.css">
</head><body><div class="market-plugin-grid" id="cards"></div>
<script type="module">
import { pluginCard } from '/assets/js/app.js';
const base = {
  id: 'preview-test', name: 'Preview test', author: 'Example', category: 'Desktop',
  tags: [], initials: 'PT', accent: 'lime', description: 'Preview regression fixture',
  previewThumbnail: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240"><rect width="720" height="240" fill="orange"/></svg>'),
  previewThumbnailWidth: 720, previewThumbnailHeight: 240
};
document.documentElement.dataset.theme = new URL(location.href).searchParams.get('theme');
document.querySelector('#cards').innerHTML = [
  base, { ...base, id: 'desktop-test', previewThumbnailHeight: 405 }
].map(plugin => pluginCard(plugin)).join('');
await Promise.all([...document.images].map(image => image.decode()));
await new Promise(resolve => setTimeout(resolve, 100));
const measure = element => {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
};
const previews = [...document.querySelectorAll('.image-preview')];
const results = previews.map(preview => ({
  fit: getComputedStyle(preview.querySelector('img')).objectFit,
  frame: measure(preview), card: measure(preview.closest('.plugin-card'))
}));
// Compare against the same card with its wide classification removed.
previews[0].classList.remove('is-wide');
results.push({ frame: measure(previews[0]), card: measure(previews[0].closest('.plugin-card')), width: innerWidth });
const output = document.createElement('pre');
output.id = 'render-result';
output.textContent = JSON.stringify(results);
document.body.append(output);
</script></body></html>`;

test("rendered cards contain wide banners, retain desktop cover, and preserve frame size", {
  skip: !chrome && "Install Chromium or set CHROME_BIN to run the browser regression check",
  timeout: 120_000,
}, async (t) => {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(fixture);
        return;
      }
      const url = new URL(`.${path}`, site);
      if (!url.href.startsWith(site.href)) throw new Error("Invalid fixture path");
      let content = await readFile(url, "utf8");
      if (path === "/assets/js/app.js") {
        // Exercise the production renderer without starting the catalog UI.
        assert.ok(content.endsWith("init();\n"));
        content = content.slice(0, -"init();\n".length) + "export { pluginCard };\n";
      }
      response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const width of [375, 1024, 1440]) {
    for (const theme of ["light", "dark"]) {
      const profile = await mkdtemp(join(tmpdir(), "preview-fit-"));
      try {
        const child = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu",
          `--user-data-dir=${profile}`, `--window-size=${width},900`, "--force-device-scale-factor=1",
          "--disable-background-networking", "--virtual-time-budget=5000", "--dump-dom",
          `http://127.0.0.1:${server.address().port}/?theme=${theme}`]);
        let output = "";
        let errors = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { errors += chunk; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        const [code] = await once(child, "close");
        clearTimeout(timer);
        assert.equal(code, 0, errors);
        const result = output.match(/<pre id="render-result">([^<]+)<\/pre>/);
        assert.ok(result, `Renderer did not finish at ${width}px (${theme})`);
        const [wide, desktop, baseline] = JSON.parse(result[1]);
        const context = `${width}px (${theme})`;
        assert.equal(wide.fit, "contain", context);
        assert.equal(desktop.fit, baseline.width <= 760 ? "contain" : "cover", context);
        assert.ok(wide.frame.width > 0 && wide.frame.height > 0, context);
        assert.deepEqual(wide.frame, desktop.frame, context);
        assert.deepEqual(wide.frame, baseline.frame, context);
        assert.deepEqual(wide.card, baseline.card, context);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
});
