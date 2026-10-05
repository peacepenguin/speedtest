/**
 * Design by fromScratch Studio - 2022, 2023 (fromscratch.io)
 * Implementation in HTML/CSS/JS by Timendus - 2024 (https://github.com/Timendus)
 *
 * See https://github.com/librespeed/speedtest/issues/585
 */

// States the UI can be in
const INITIALIZING = 0;
const READY = 1;
const RUNNING = 2;
const FINISHED = 3;

// Keep some global state here
const testState = {
  state: INITIALIZING,
  speedtest: null,
  servers: [],
  initialGaugeScrollPending: false,
  initialGaugeScrollScheduled: false,
  selectedServerDirty: false,
  pingingServers: false,
  testData: null,
  testDataDirty: false,
  telemetryEnabled: false,
};

// Bootstrap the application when the DOM is ready
window.addEventListener("DOMContentLoaded", async () => {
  createSpeedtest();
  hookUpButtons();
  startRenderingLoop();
  applySettingsJSON();
  applyServerListJSON();
});

/**
 * Create a new Speedtest and hook it into the global state
 */
function createSpeedtest() {
  testState.speedtest = new Speedtest();
  // Also measure latency and jitter while downloading and uploading
  testState.speedtest.setParameter("loaded_ping", true);
  testState.speedtest.onupdate = (data) => {
    testState.testData = data;
    testState.testDataDirty = true;
  };
  testState.speedtest.onend = (aborted) =>
    (testState.state = aborted ? READY : FINISHED);
}

/**
 * Make all the buttons respond to the right clicks
 */
function hookUpButtons() {
  document
    .querySelector("#start-button")
    .addEventListener("click", startButtonClickHandler);
  document
    .querySelector("#choose-privacy")
    .addEventListener("click", () =>
      document.querySelector("#privacy").showModal()
    );
  document
    .querySelector("#share-results")
    .addEventListener("click", () =>
      document.querySelector("#share").showModal()
    );
  document
    .querySelector("#copy-link")
    .addEventListener("click", copyLinkButtonClickHandler);
  document
    .querySelector("#results-link")
    .addEventListener("click", (event) => event.target.select());
  document
    .querySelectorAll(".close-dialog, #close-privacy")
    .forEach((element) => {
      element.addEventListener("click", () =>
        document.querySelectorAll("dialog").forEach((modal) => modal.close())
      );
    });
}

/**
 * Event listener for clicks on the main start button
 */
function startButtonClickHandler() {
  switch (testState.state) {
    case READY:
    case FINISHED:
      testState.speedtest.start();
      testState.initialGaugeScrollPending = true;
      testState.state = RUNNING;
      return;
    case RUNNING:
      testState.speedtest.abort();
      // testState.state is updated by `onend` handler of speedtest
      return;
    default:
      return;
  }
}

/**
 * Scroll the initial download gauge into view on narrow viewports when starting a test
 */
function scrollInitialDownloadGaugeIntoView() {
  if (!window.matchMedia("(max-width: 800px)").matches) {
    return;
  }

  const downloadGauge = document.querySelector("#download-gauge");
  if (!downloadGauge) {
    return;
  }

  const { top, bottom } = downloadGauge.getBoundingClientRect();
  if (top >= 0 && bottom <= window.innerHeight) {
    return;
  }

  downloadGauge.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
}

/**
 * Event listener for clicks on the "Copy link" button in the modal
 */
async function copyLinkButtonClickHandler() {
  const link = document.querySelector("img#results").src;
  await navigator.clipboard.writeText(link);
  const button = document.querySelector("#copy-link");
  button.classList.add("active");
  button.textContent = "Copied!";
  setTimeout(() => {
    button.classList.remove("active");
    button.textContent = "Copy link";
  }, 3000);
}

/**
 * Load settings from settings.json on the server and apply them
 */
async function applySettingsJSON() {
  try {
    const response = await fetch("settings.json");
    const settings = await response.json();
    if (!settings || typeof settings !== "object") {
      return console.error("Settings are empty or malformed");
    }
    for (let setting in settings) {
      testState.speedtest.setParameter(setting, settings[setting]);
      if (
        setting == "telemetry_level" &&
        settings[setting] &&
        settings[setting] != "off" &&
        settings[setting] != "disabled" &&
        settings[setting] != "false"
      ) {
        testState.telemetryEnabled = true;
        document.querySelector("#privacy-warning").classList.remove("hidden");
      }
    }
  } catch (error) {
    console.error("Failed to fetch settings:", error);
  }
}

/**
 * Load server list from the configured source and populate the dropdown
 */
async function applyServerListJSON() {
  try {
    const serverSource =
      typeof globalThis.SPEEDTEST_SERVERS !== "undefined"
        ? globalThis.SPEEDTEST_SERVERS
        : "server-list.json";
    let servers; // reassigned below when the local server is added
    if (Array.isArray(serverSource)) {
      servers = serverSource;
    } else {
      // A missing server-list.json (404) or a non-JSON response means a
      // standalone install: just test against the server hosting this page.
      const response = await fetch(serverSource);
      servers = response.ok ? await response.json().catch(() => null) : null;
    }
    if (!servers || !Array.isArray(servers) || servers.length === 0) {
      return useLocalServer();
    }

    // The server hosting this page is a choice, unless the list already
    // contains it.
    const local = localServerDefinition();
    let localCandidate = servers.find((s) => sameBackend(s, local));
    if (!localCandidate) {
      localCandidate = local;
      servers = [local, ...servers];
    }

    // A frontend-only deployment has no backend next to the page, so the local
    // server is only offered (and made the default) when it actually answers.
    const localWorks = await probeServer(localCandidate);
    if (!localWorks) {
      servers = servers.filter((s) => s !== localCandidate);
    }
    if (servers.length === 0) {
      return useLocalServer();
    }

    testState.servers = servers;

    // "mpot" makes the backend send CORS headers so remote servers work.
    testState.speedtest.setParameter("mpot", true);
    populateDropdown(servers);
    if (servers.length > 1) {
      hookUpFindClosestButton();
      if (localWorks) {
        // Default to the local server; pinging the other servers only happens
        // when the user asks for it with the "Find closest server" button.
        selectServer(localCandidate);
      } else {
        // Nothing local to default to: the configured servers are all there is,
        // so pick the closest one.
        findClosestServer(true);
      }
    }
  } catch (error) {
    console.error("Failed to load server list:", error);
    useLocalServer();
  }
}

/**
 * Ping all known servers with a separate Speedtest instance (so the main one
 * stays selectable), show the results in the dropdown and switch to the
 * server with the lowest ping.
 */
function findClosestServer(autoSelect = false) {
  const button = document.querySelector("#find-closest");
  if (testState.state === RUNNING || testState.pingingServers) return;
  testState.pingingServers = true;
  button.textContent = "Pinging...";

  const finder = new Speedtest();
  finder.addTestPoints(testState.servers);
  finder.selectServer((bestServer) => {
    // Show results lowest ping first, unreachable servers last
    const pingOf = (s) => (s.pingT > 0 ? s.pingT : Infinity);
    testState.servers.sort((a, b) => pingOf(a) - pingOf(b));
    populateDropdown(testState.servers);

    if (bestServer && testState.state !== RUNNING) {
      selectServer(bestServer);
    } else if (autoSelect && !bestServer) {
      // nothing answered, but the page still needs a server to work with
      selectServer(testState.servers[0]);
    }
    testState.pingingServers = false;
    button.textContent = bestServer
      ? "Find closest server again"
      : "No servers reachable - retry";
  });
}

function hookUpFindClosestButton() {
  const button = document.querySelector("#find-closest");
  button.classList.remove("hidden");
  button.addEventListener("click", (event) => {
    // The button lives inside the server selector, whose click handler would
    // otherwise toggle the dropdown open.
    event.stopPropagation();
    findClosestServer();
  });
}

/**
 * Whether two server definitions point at the same download URL once resolved
 * against the page, so "/backend" and "http://host/backend/" count as one.
 * @returns {boolean}
 */
function sameBackend(a, b) {
  const resolve = (s) => {
    try {
      return new URL(s.server.replace(/\/?$/, "/") + s.dlURL, location.href).href;
    } catch (error) {
      return null;
    }
  };
  const resolved = resolve(a);
  return resolved !== null && resolved === resolve(b);
}

/**
 * Checks that a server answers its ping URL, without measuring anything.
 * @param {Object} server - a server object
 * @returns {Promise<boolean>}
 */
async function probeServer(server) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const base = server.server.replace(/\/?$/, "/");
    const url = new URL(base + server.pingURL, location.href);
    url.searchParams.set("cors", "true");
    url.searchParams.set("r", Math.random());
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Server definition for the server hosting this page, using the default
 * backend paths.
 */
function localServerDefinition() {
  return {
    name: "This server (local)",
    server: new URL(".", location.href).href,
    dlURL: "backend/garbage.php",
    ulURL: "backend/empty.php",
    pingURL: "backend/empty.php",
    getIpURL: "backend/getIP.php",
    isLocal: true,
  };
}

/**
 * Standalone mode: no server list available, so test against the server that
 * served this page, using the default backend paths from speedtest.js.
 */
function useLocalServer() {
  const serverSelector = document.querySelector("div.server-selector");
  serverSelector.classList.add("single-server");
  serverSelector.querySelector("#selected-server").textContent =
    location.hostname;
  testState.state = READY;
}

/**
 * Add all the servers to the server selection dropdown and make it actually
 * work.
 * @param {Array} servers - an array of server objects
 */
function populateDropdown(servers) {
  const serverSelector = document.querySelector("div.server-selector");
  const serverList = serverSelector.querySelector("ul.servers");

  // Reset previous state (populateDropdown can be called multiple times)
  serverSelector.classList.remove("single-server");
  serverSelector.classList.remove("active");
  serverList.classList.remove("active");
  serverList.innerHTML = "";

  // If we have only a single server, just show it
  if (servers.length === 1) {
    serverSelector.classList.add("single-server");
    selectServer(servers[0]);
    return;
  }
  serverSelector.classList.add("active");

  // Make the dropdown open and close (hook only once)
  if (serverSelector.dataset.hooked !== "1") {
    serverSelector.dataset.hooked = "1";

    serverSelector.addEventListener("click", () => {
      serverList.classList.toggle("active");
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest("div.server-selector") !== serverSelector)
        serverList.classList.remove("active");
    });
  }

  // Sort servers by country, then by city within the same country.
  // Name formats: "City, Country", "City, Country (qualifier)", "City, Country, Provider", "Country"
  const parseServerName = (name) => {
    const parts = (name || "").split(",").map((s) => s.trim());
    let country, city;
    if (parts.length >= 3) {
      // "City, Country, Provider" — use second part as country
      country = parts[1];
      city = parts[0];
    } else if (parts.length === 2) {
      country = parts[1];
      city = parts[0];
    } else {
      country = parts[0];
      city = "";
    }
    // Strip parenthetical qualifiers for sorting: "Germany (1) (Hetzner)" → "Germany"
    country = country.replace(/\s*\([^)]*\)\s*/g, "").trim();
    return { country, city };
  };
  // Once pings have been measured, keep the order given (lowest ping first)
  const measured = servers.some((s) => s.pingT !== undefined);
  const sorted = [...servers].sort((a, b) => {
    if (measured) return 0;
    // Local server always comes first
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    const pa = parseServerName(a.name);
    const pb = parseServerName(b.name);
    return pa.country.localeCompare(pb.country) || pa.city.localeCompare(pb.city);
  });

  // Populate the list to choose from
  sorted.forEach((server) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    const ping =
      server.pingT === undefined
        ? ""
        : server.pingT > 0
        ? ` <span>- ${Math.round(server.pingT)} ms</span>`
        : " <span>- unreachable</span>";
    link.innerHTML = `${server.name}${
      server.sponsorName ? ` <span>(${server.sponsorName})</span>` : ""
    }${ping}`;
    link.addEventListener("click", () => selectServer(server));
    item.appendChild(link);
    serverList.appendChild(item);
  });
}

/**
 * Set the given server as the selected server for the speedtest
 * @param {Object} server - a server object
 */
function selectServer(server) {
  testState.speedtest.setSelectedServer(server);
  testState.selectedServerDirty = true;
  testState.state = READY;
}

/**
 * Start the requestAnimationFrame UI rendering loop
 */
function startRenderingLoop() {
  // Do these queries once to speed up the rendering itself
  const serverSelector = document.querySelector("div.server-selector");
  const selectedServer = serverSelector.querySelector("#selected-server");
  const sponsor = serverSelector.querySelector("#sponsor");
  const startButton = document.querySelector("#start-button");
  const findClosestButton = document.querySelector("#find-closest");
  const privacyWarning = document.querySelector("#privacy-warning");

  const gauges = document.querySelectorAll("#download-gauge, #upload-gauge");
  const downloadProgress = document.querySelector("#download-gauge .progress");
  const uploadProgress = document.querySelector("#upload-gauge .progress");
  const downloadGauge = document.querySelector("#download-gauge .speed");
  const uploadGauge = document.querySelector("#upload-gauge .speed");
  const downloadText = document.querySelector("#download-gauge span");
  const uploadText = document.querySelector("#upload-gauge span");

  const pingAndJitter = document.querySelectorAll(".ping, .jitter");
  const ping = document.querySelector("#ping");
  const jitter = document.querySelector("#jitter");
  const latencySummary = document.querySelector("#latency-summary");
  const shareResults = document.querySelector("#share-results");
  const copyLink = document.querySelector("#copy-link");
  const resultsImage = document.querySelector("#results");

  const buttonTexts = {
    [INITIALIZING]: "Loading...",
    [READY]: "Let's start",
    [RUNNING]: "Abort",
    [FINISHED]: "Restart",
  };

  // Show copy link button only if navigator.clipboard is available
  copyLink.classList.toggle("hidden", !navigator.clipboard);

  function renderUI() {
    // Make the main button reflect the current state
    startButton.textContent = buttonTexts[testState.state];
    startButton.classList.toggle("disabled", testState.state === INITIALIZING);
    startButton.classList.toggle("active", testState.state === RUNNING);

    // Disable the server selector while test is running
    serverSelector.classList.toggle("disabled", testState.state === RUNNING);
    findClosestButton.disabled =
      testState.state === RUNNING || testState.pingingServers;

    // Show selected server
    if (testState.selectedServerDirty) {
      const server = testState.speedtest.getSelectedServer();
      selectedServer.textContent = server.name;
      if (server.sponsorName) {
        if (server.sponsorURL) {
          sponsor.innerHTML = `Sponsor: <a href="${server.sponsorURL}">${server.sponsorName}</a>`;
        } else {
          sponsor.textContent = `Sponsor: ${server.sponsorName}`;
        }
      } else {
        sponsor.innerHTML = "&nbsp;";
      }
      testState.selectedServerDirty = false;
    }

    // Activate the gauges when test running or finished
    gauges.forEach((e) =>
      e.classList.toggle(
        "enabled",
        testState.state === RUNNING || testState.state === FINISHED
      )
    );

    if (
      testState.state === RUNNING &&
      testState.initialGaugeScrollPending &&
      !testState.initialGaugeScrollScheduled
    ) {
      testState.initialGaugeScrollScheduled = true;
      requestAnimationFrame(() => {
        if (testState.state === RUNNING) {
          scrollInitialDownloadGaugeIntoView();
        }
        testState.initialGaugeScrollPending = false;
        testState.initialGaugeScrollScheduled = false;
      });
    }

    // Show ping and jitter if data is available
    pingAndJitter.forEach((e) =>
      e.classList.toggle(
        "hidden",
        !(
          testState.testData &&
          testState.testData.pingStatus &&
          testState.testData.jitterStatus
        )
      )
    );

    // Show share button after test if server supports it
    shareResults.classList.toggle(
      "hidden",
      !(
        testState.state === FINISHED &&
        testState.telemetryEnabled &&
        testState.testData.testId
      )
    );

    if (testState.testDataDirty) {
      // Set gauge rotations
      downloadProgress.style = `--progress-rotation: ${
        testState.testData.dlProgress * 180
      }deg`;
      uploadProgress.style = `--progress-rotation: ${
        testState.testData.ulProgress * 180
      }deg`;
      downloadGauge.style = `--speed-rotation: ${mbpsToRotation(
        testState.testData.dlStatus,
        testState.testData.testState === 1
      )}deg`;
      uploadGauge.style = `--speed-rotation: ${mbpsToRotation(
        testState.testData.ulStatus,
        testState.testData.testState === 3
      )}deg`;

      // Set numeric values
      downloadText.textContent = numberToText(testState.testData.dlStatus);
      uploadText.textContent = numberToText(testState.testData.ulStatus);
      ping.textContent = numberToText(testState.testData.pingStatus);
      jitter.textContent = numberToText(testState.testData.jitterStatus);

      // Latency and jitter at idle, during download and during upload
      const d = testState.testData;
      const ms = (v) => (v ? `${numberToText(v)} ms` : "--");
      latencySummary.classList.toggle("hidden", !d.pingStatus);
      document.querySelector("#lat-idle").textContent = ms(d.pingStatus);
      document.querySelector("#jit-idle").textContent = ms(d.jitterStatus);
      document.querySelector("#lat-dl").textContent = ms(d.dlPingStatus);
      document.querySelector("#jit-dl").textContent = ms(d.dlJitterStatus);
      document.querySelector("#lat-ul").textContent = ms(d.ulPingStatus);
      document.querySelector("#jit-ul").textContent = ms(d.ulJitterStatus);

      // Set user's IP and provider
      if (testState.testData.clientIp) {
        // Clear previous content
        privacyWarning.innerHTML = '';

        const connectedThrough = document.createElement('span');
        connectedThrough.textContent = 'You are connected through:';
  
        const ipAddress = document.createTextNode(testState.testData.clientIp);

        privacyWarning.appendChild(connectedThrough);
        privacyWarning.appendChild(document.createElement('br'));
        privacyWarning.appendChild(ipAddress);
  
        privacyWarning.classList.remove("hidden");
      }

      // Set image for sharing results
      if (testState.testData.testId) {
        document.querySelector("#results-id-value").textContent =
          testState.testData.testId;
        resultsImage.src =
          window.location.href.substring(
            0,
            window.location.href.lastIndexOf("/")
          ) +
          "/results/?id=" +
          testState.testData.testId +
          // Ask for the design this frontend matches; the classic frontend
          // links the same URL and gets the classic image without asking.
          "&style=modern";
        document.querySelector("#results-link").value = resultsImage.src;
      }

      testState.testDataDirty = false;
    }

    requestAnimationFrame(renderUI);
  }

  renderUI();
}

/**
 * Convert a speed in Mbits per second to a rotation for the gauge
 * @param {string} speed Speed in Mbits
 * @param {boolean} oscillate If the gauge should wiggle a bit
 * @returns {number} Rotation for the gauge in degrees
 */
function mbpsToRotation(speed, oscillate) {
  speed = Number(speed);
  if (speed <= 0) return 0;

  const minSpeed = 0;
  const maxSpeed = 10000; // 10 Gbps maxes out the gauge
  const minRotation = 0;
  const maxRotation = 180;

  // Can't do log10 of values less than one, +1 all to keep it fair
  const logMinSpeed = Math.log10(minSpeed + 1);
  const logMaxSpeed = Math.log10(maxSpeed + 1);
  const logSpeed = Math.log10(speed + 1);

  const power = (logSpeed - logMinSpeed) / (logMaxSpeed - logMinSpeed);
  const oscillation = oscillate ? 1 + 0.01 * Math.sin(Date.now() / 100) : 1;
  const rotation = power * oscillation * maxRotation;

  // Make sure we stay within bounds at all times
  return Math.max(Math.min(rotation, maxRotation), minRotation);
}

/**
 * Convert a number to a user friendly version
 * @param {string} value Speed, ping or jitter
 * @returns {string} A text version with proper decimals
 */
function numberToText(value) {
  if (!value) return "00";
  value = Number(value);
  if (value < 10) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return value.toFixed(0);
}
