const { test, expect } = require("@playwright/test");
const { baseUrls } = require("./helpers/env");
const { modernStartButton, classicStartButton } = require("./helpers/ui");

const MODERN = `${baseUrls.standaloneNew}/index-modern.html`;

// A short test so the whole run (download, upload, ping) stays well inside the timeout.
const SHORT_SETTINGS = {
  telemetry_level: "off",
  test_order: "IP_D_U",
  time_dl_max: 3,
  time_ul_max: 3,
  time_dlGraceTime: 0,
  time_ulGraceTime: 0,
  time_auto: false,
};

function remoteServer(name, host) {
  return {
    name,
    server: `http://${host}/`,
    dlURL: "garbage.php",
    ulURL: "empty.php",
    pingURL: "empty.php",
    getIpURL: "getIP.php",
  };
}

// Answers pings for a fake host (nothing resolves it, the route is the server).
async function fakeRemote(page, host, delayMs, counter) {
  await page.route(`http://${host}/**`, async (route) => {
    counter.count++;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "",
    });
  });
}

async function serveServerList(page, servers) {
  await page.route("**/server-list.json", (route) =>
    route.fulfill({
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(servers),
    })
  );
}

async function useShortSettings(page) {
  await page.route("**/settings.json", (route) =>
    route.fulfill({
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(SHORT_SETTINGS),
    })
  );
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test.describe("Modern server selection", () => {
  test("defaults to this server without pinging the listed ones, until asked", async ({ page }) => {
    const fast = { count: 0 };
    const slow = { count: 0 };
    await serveServerList(page, [remoteServer("Fast", "fast.test"), remoteServer("Slow", "slow.test")]);
    await fakeRemote(page, "fast.test", 50, fast);
    await fakeRemote(page, "slow.test", 900, slow);
    // The local backend answers the probe made when the page loads (the first
    // request) but not the pings of the closest-server check (a non-empty body
    // counts as a failed ping), so "Fast" is the closest server whatever the
    // timing of the browser is.
    let localRequests = 0;
    await page.route("**/backend/empty.php**", async (route) => {
      localRequests++;
      if (localRequests === 1) {
        await route.continue();
      } else {
        await route.fulfill({ status: 200, body: "not empty" });
      }
    });

    await page.goto(MODERN);
    await expect(modernStartButton(page)).toHaveText("Let's start");
    await expect(page.locator("#selected-server")).toHaveText("This server (local)");

    // nothing contacted the listed servers on load
    await page.waitForTimeout(500);
    expect(fast.count + slow.count).toBe(0);

    const button = page.locator("#find-closest");
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Find closest server");

    await button.click();
    await expect(button).toHaveText("Pinging...");
    await expect(button).toBeDisabled();
    // clicking the button must not pop the dropdown open
    await expect(page.locator("ul.servers")).not.toHaveClass(/active/);

    await expect(page.locator("#selected-server")).toHaveText("Fast", { timeout: 20_000 });
    await expect(button).toHaveText("Find closest server again");
    await expect(button).toBeEnabled();
    await expect(page.locator("ul.servers")).not.toHaveClass(/active/);
    expect(fast.count).toBeGreaterThan(0);
    expect(slow.count).toBeGreaterThan(0);

    // opening the list shows the ping of every server, lowest first
    await page.locator(".server-selector .chosen").click();
    const items = page.locator("ul.servers li");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText(/Fast.*\d+ ms/i);
    await expect(items.nth(1)).toContainText(/Slow.*\d+ ms/i);
    await expect(items.nth(2)).toContainText(/This server \(local\).*unreachable/i);
  });

  test("marks servers that do not answer as unreachable", async ({ page }) => {
    await serveServerList(page, [remoteServer("Gone", "gone.test")]);
    await page.route("http://gone.test/**", (route) => route.abort());

    await page.goto(MODERN);
    await expect(modernStartButton(page)).toHaveText("Let's start");

    await page.locator("#find-closest").click();
    await expect(page.locator("#find-closest")).toHaveText("Find closest server again", { timeout: 15_000 });
    // the local server is the only one that answered, so it is selected
    await expect(page.locator("#selected-server")).toHaveText("This server (local)");

    await page.locator(".server-selector .chosen").click();
    await expect(page.locator("ul.servers li").last()).toContainText(/Gone.*unreachable/i);
  });

  test("works without a server-list.json", async ({ page }) => {
    await page.route("**/server-list.json", (route) => route.fulfill({ status: 404, body: "Not found" }));

    await page.goto(MODERN);
    await expect(modernStartButton(page)).toHaveText("Let's start");
    await expect(page.locator("#find-closest")).toBeHidden();
  });

  test("does not list this server twice when the list already contains it", async ({ page }) => {
    await serveServerList(page, [
      { name: "Listed local", server: "/backend", dlURL: "garbage.php", ulURL: "empty.php", pingURL: "empty.php", getIpURL: "getIP.php" },
      remoteServer("Other", "other.test"),
    ]);
    await fakeRemote(page, "other.test", 50, { count: 0 });

    await page.goto(MODERN);
    await expect(modernStartButton(page)).toHaveText("Let's start");
    await expect(page.locator("#selected-server")).toHaveText("Listed local");

    await page.locator(".server-selector .chosen").click();
    await expect(page.locator("ul.servers li")).toHaveCount(2);
  });
});

test.describe("Latency and jitter under load", () => {
  test("modern page shows idle, download and upload values", async ({ page }) => {
    test.setTimeout(90_000);
    await useShortSettings(page);

    await page.goto(MODERN);
    await expect(modernStartButton(page)).toHaveText("Let's start");
    await expect(page.locator("#latency-summary")).toBeHidden();

    await modernStartButton(page).click();
    await expect(modernStartButton(page)).toHaveText("Restart", { timeout: 60_000 });

    await expect(page.locator("#latency-summary")).toBeVisible();
    for (const id of ["lat-idle", "jit-idle", "lat-dl", "jit-dl", "lat-ul", "jit-ul"]) {
      await expect(page.locator(`#${id}`)).toHaveText(/^\d+(\.\d+)? ms$/);
    }
  });

  test("worker reports values for both phases and none when disabled", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${baseUrls.standaloneNew}/index-modern.html`);

    const run = (loadedPing) =>
      page.evaluate(
        ({ loadedPing, url }) =>
          new Promise((resolve) => {
            const worker = new Worker(`${url}/speedtest_worker.js?r=${Math.random()}`);
            let last = null;
            worker.onmessage = (event) => {
              last = JSON.parse(event.data);
              if (last.testState === 4 || last.testState === 5) {
                worker.terminate();
                resolve(last);
              }
            };
            worker.postMessage(
              "start " +
                JSON.stringify({
                  test_order: "D_U",
                  time_dl_max: 2,
                  time_ul_max: 2,
                  time_dlGraceTime: 0,
                  time_ulGraceTime: 0,
                  time_auto: false,
                  getIp_ispInfo: false,
                  loaded_ping: loadedPing,
                  url_dl: `${url}/backend/garbage.php`,
                  url_ul: `${url}/backend/empty.php`,
                  url_ping: `${url}/backend/empty.php`,
                  url_getIp: `${url}/backend/getIP.php`,
                })
            );
            setInterval(() => worker.postMessage("status"), 200);
          }),
        { loadedPing, url: new URL(page.url()).origin }
      );

    const on = await run(true);
    for (const key of ["dlPingStatus", "dlJitterStatus", "ulPingStatus", "ulJitterStatus"]) {
      expect(Number(on[key])).toBeGreaterThanOrEqual(0);
      expect(on[key]).not.toBe("");
    }

    const off = await run(false);
    for (const key of ["dlPingStatus", "dlJitterStatus", "ulPingStatus", "ulJitterStatus"]) {
      expect(off[key]).toBe("");
    }
  });

  test("classic page shows idle, download and upload values", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${baseUrls.standalone}/index-classic.html`);
    await expect(classicStartButton(page)).toBeVisible();
    await expect(page.locator("#loadedLatency")).toBeHidden();

    await classicStartButton(page).click();
    // the upload column is filled in last, once the upload phase has produced samples
    await expect(page.locator("#latUl")).toHaveText(/^\d+(\.\d+)?$/, { timeout: 100_000 });
    await expect(page.locator("#loadedLatency")).toBeVisible();
    for (const id of ["latIdle", "jitIdle", "latDl", "jitDl", "jitUl"]) {
      await expect(page.locator(`#${id}`)).toHaveText(/^\d+(\.\d+)?$/);
    }
  });
});

test.describe("Stability test duration", () => {
  test("offers a 10 second test and sizes the chart window to it", async ({ page }) => {
    await page.goto(`${baseUrls.standalone}/stability.html`);

    const options = await page.locator("#durationSelect option").evaluateAll((nodes) => nodes.map((n) => n.value));
    expect(options[0]).toBe("10");
    expect(options).toContain("60");
    await expect(page.locator("#durationSelect")).toHaveValue("60");
  });

  test("a single target dropdown holds this server, listed servers and internet hosts", async ({ page }) => {
    await page.goto(`${baseUrls.standalone}/stability.html`);

    await expect(page.locator("#serverArea")).toHaveCount(0);
    const groups = await page.locator("#targetSelect optgroup").evaluateAll((nodes) => nodes.map((n) => n.label));
    expect(groups).toEqual(["Speedtest servers", "Internet hosts"]);
    await expect(page.locator('#targetSelect option[value="local"]')).toHaveText("This server (local)");
  });
});

test.describe("Telemetry with latency under load", () => {
  // Needs a deployment with telemetry configured; skipped where it is not.
  async function storeResult(request, extra) {
    const response = await request.post(`${baseUrls.standaloneNew}/results/telemetry.php`, {
      form: {
        ispinfo: JSON.stringify({ processedString: "127.0.0.1 - private IPv4 access", rawIspInfo: "" }),
        extra: "",
        dl: "123.45",
        ul: "67.89",
        ping: "1.50",
        jitter: "0.50",
        log: "",
        ...extra,
      },
    });
    const body = response.ok() ? await response.text() : "";
    return body.startsWith("id ") ? body.slice(3).trim() : null;
  }

  const LOADED = { dl_ping: "12.38", dl_jitter: "2.10", ul_ping: "23.41", ul_jitter: "3.20" };

  test("stores the values and returns them, with taller images for both designs", async ({ request }) => {
    const id = await storeResult(request, LOADED);
    test.skip(id === null, "telemetry storage is not available in this deployment");

    const json = await request.get(`${baseUrls.standaloneNew}/results/json.php?id=${id}`);
    const data = await json.json();
    expect(data).toMatchObject({ download_ping: "12.4", download_jitter: "2.10", upload_ping: "23.4", upload_jitter: "3.20" });

    for (const style of ["modern", "classic"]) {
      const image = await request.get(`${baseUrls.standaloneNew}/results/?id=${id}&style=${style}`);
      expect(image.headers()["content-type"]).toContain("image/png");
      const withLoaded = pngSize(await image.body());

      const plainId = await storeResult(request, {});
      const plain = await request.get(`${baseUrls.standaloneNew}/results/?id=${plainId}&style=${style}`);
      const withoutLoaded = pngSize(await plain.body());

      // results with the values get an extra panel (modern) or rows (classic)
      expect(withLoaded.width).toBe(withoutLoaded.width);
      expect(withLoaded.height).toBeGreaterThan(withoutLoaded.height);
    }
  });

  test("results stored without the values still render and omit the fields from json", async ({ request }) => {
    const id = await storeResult(request, {});
    test.skip(id === null, "telemetry storage is not available in this deployment");

    const data = await (await request.get(`${baseUrls.standaloneNew}/results/json.php?id=${id}`)).json();
    expect(data).toMatchObject({ download: "123", upload: "67.9" });
    expect(data).not.toHaveProperty("download_ping");

    const modern = await request.get(`${baseUrls.standaloneNew}/results/?id=${id}&style=modern`);
    expect(pngSize(await modern.body())).toEqual({ width: 800, height: 480 });
  });
});
