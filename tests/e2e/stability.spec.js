const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { baseUrls } = require("./helpers/env");
const { stabilityStartButton } = require("./helpers/ui");

const workerSource = fs.readFileSync(path.join(__dirname, "..", "..", "stability_worker.js"), "utf8");

async function setShortDuration(page) {
  await page.evaluate(() => {
    const select = document.querySelector("#durationSelect");
    const option = document.createElement("option");
    option.value = "1";
    option.textContent = "1 Second";
    select.insertBefore(option, select.firstChild);
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function setAlertThreshold(page, value) {
  await page.evaluate(threshold => {
    const input = document.querySelector("#alertThreshold");
    input.value = String(threshold);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function waitForSamples(page) {
  await expect.poll(() => page.evaluate(() => window.allPingData.length), { timeout: 10_000 }).toBeGreaterThan(0);
}

async function waitForLocalServer(page, serverName) {
  // listed servers are added to the target dropdown once their pings are back
  await expect(page.locator('#targetSelect option[value^="srv:"]')).toContainText(serverName, { timeout: 10_000 });
}

test.describe("Stability test", () => {
  test("offers this server immediately and adds listed servers after discovery", async ({ page }) => {
    let releaseServerProbe;
    const serverProbe = new Promise(resolve => {
      releaseServerProbe = resolve;
    });

    await page.route(/\/backend\/empty\.php\?cors=true/, async route => {
      await serverProbe;
      await route.fulfill({ status: 200, body: "" });
    });

    await page.goto(`${baseUrls.standalone}/stability.html`);

    // there is a single target dropdown, and starting never waits for discovery
    await expect(page.locator("#serverArea")).toHaveCount(0);
    await expect(page.locator("#targetSelect option[value=\"local\"]")).toHaveText("This server (local)");
    await expect(page.locator("#targetSelect")).toHaveValue("local");
    await expect(stabilityStartButton(page)).not.toHaveClass(/disabled/);
    await expect(stabilityStartButton(page)).toHaveAttribute("aria-disabled", "false");
    await expect(page.locator('#targetSelect option[value^="srv:"]')).toHaveCount(0);

    releaseServerProbe();

    await waitForLocalServer(page, "local");
    await expect(stabilityStartButton(page)).not.toHaveClass(/disabled/);
  });

  test("runs a short local measurement and exports CSV data", async ({ page }) => {
    await page.goto(`${baseUrls.standalone}/stability.html`);

    await expect(page).toHaveTitle("LibreSpeed - Stability Test");
    await waitForLocalServer(page, "local");

    await setShortDuration(page);
    await stabilityStartButton(page).click();

    await expect(stabilityStartButton(page)).toHaveClass(/running/);
    await expect(page.locator("#durationSelect")).toBeDisabled();
    await expect(page.locator("#targetSelect")).toBeDisabled();

    await waitForSamples(page);
    await expect(page.locator("#statAvg")).not.toHaveText("", { timeout: 5_000 });
    await expect(page.locator("#rating")).not.toHaveText("--", { timeout: 5_000 });

    await expect(stabilityStartButton(page)).not.toHaveClass(/running/, { timeout: 10_000 });
    await expect(page.locator("#durationSelect")).toBeEnabled();

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadCsvBtn").click()]);
    expect(download.suggestedFilename()).toMatch(/^stability_test_.*\.csv$/);

    const csvPath = await download.path();
    const csv = fs.readFileSync(csvPath, "utf8");
    expect(csv).toContain("elapsed_s,ping_ms,failed\n");
    expect(csv.trim().split("\n").length).toBeGreaterThan(1);
  });

  test("supports threshold display, abort, and reset controls", async ({ page }) => {
    await page.goto(`${baseUrls.standalone}/stability.html`);
    await waitForLocalServer(page, "local");

    await setAlertThreshold(page, 40);
    await expect(page.locator("#thresholdValue")).toHaveText("40 ms");

    await stabilityStartButton(page).click();
    await expect(stabilityStartButton(page)).toHaveClass(/running/);
    await waitForSamples(page);

    await stabilityStartButton(page).click();
    await expect(stabilityStartButton(page)).not.toHaveClass(/running/);
    await expect(page.locator("#durationSelect")).toBeEnabled();
    await expect(page.locator("#targetSelect")).toBeEnabled();

    await page.waitForTimeout(700);
    await page.locator("#resetBtn").click();

    await expect(page.locator("#rating")).toHaveText("--");
    await expect(page.locator("#statAvg")).toHaveText("");
    await expect.poll(() => page.evaluate(() => window.allPingData.length)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.latestData)).toBeNull();
  });

  test("loads the configured dual-mode server list", async ({ page }) => {
    await page.goto(`${baseUrls.dual}/stability.html`);

    await waitForLocalServer(page, "Local dual backend");
  });

  test("clears resource timings after measuring a ping", async ({ page }) => {
    await page.goto(`${baseUrls.standalone}/stability.html`);
    await page.route(`${baseUrls.backend}/empty.php?cors=true&r=*`, route => route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, body: "" }));

    await expect(
      page.evaluate(
        async ({ source, url }) => {
          const instrumentedSource = `
          const clearResourceTimings = performance.clearResourceTimings.bind(performance);
          performance.clearResourceTimings = () => {
            postMessage("resource timings cleared");
            clearResourceTimings();
          };
          ${source}
        `;
          const worker = new Worker(URL.createObjectURL(new Blob([instrumentedSource], { type: "text/javascript" })));
          try {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("Resource timings were not cleared")), 10_000);
              worker.onmessage = event => {
                if (event.data === "resource timings cleared") {
                  clearTimeout(timeout);
                  resolve();
                }
              };
              worker.postMessage(`start ${JSON.stringify({ url_ping: url, duration: 1, mpot: true })}`);
            });
          } finally {
            worker.terminate();
          }
        },
        { source: workerSource, url: `${baseUrls.backend}/empty.php` }
      )
    ).resolves.toBeUndefined();
  });
});
