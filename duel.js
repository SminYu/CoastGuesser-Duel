const COAST_DATA_URL = "https://raw.githubusercontent.com/SminYu/CoastGuesser/main/data/ne_50m_coastline/ne_50m_coastline.shp";
const LAND_DATA_URL = "https://raw.githubusercontent.com/SminYu/CoastGuesser/main/data/ne_50m_land/ne_50m_land.shp";
const ROUND_COUNT = 10;
const ROUND_TIME_MS = 30 * 1000;
const MAX_ROUND_SCORE = 100;
const EARTH_RADIUS_KM = 6371;
const SAMPLING_WEIGHT_EXPONENT = 0.3;
const MIN_QUESTION_LATITUDE = -65;
const MAX_QUESTION_LATITUDE = 65;
const MIN_ROUND_SEPARATION_KM = 1200;
const LAND_RATIO_SAMPLE_WIDTH = 120;

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const DIFFICULTIES = {
  easy: {
    label: "쉬움",
    widthKm: 1500,
    minCoastlineLengthKm: 300,
    scoreDecayDistanceKm: 6000,
    minLandOrWaterRatio: 0.15
  },
  normal: {
    label: "보통",
    widthKm: 1000,
    minCoastlineLengthKm: 100,
    scoreDecayDistanceKm: 5000,
    minLandOrWaterRatio: 0.1
  },
  hard: {
    label: "어려움",
    widthKm: 600,
    minCoastlineLengthKm: 50,
    scoreDecayDistanceKm: 4000,
    minLandOrWaterRatio: 0.05
  }
};

const state = {
  role: null,
  slot: null,
  nickname: "",
  ready: false,
  readySent: false,
  dataReady: false,
  difficultyKey: "normal",
  coastSource: null,
  coast: null,
  land: null,
  rounds: [],
  roundIndex: -1,
  phase: "lobby",
  endsAt: null,
  timerId: null,
  guess: null,
  submitted: false,
  scores: { p1: 0, p2: 0 },
  lastRound: null,
  players: {
    p1: { nickname: "대기 중", connected: false, ready: false, submitted: false },
    p2: { nickname: "대기 중", connected: false, ready: false, submitted: false }
  },
  host: {
    peers: {
      p1: { pc: null, channel: null },
      p2: { pc: null, channel: null }
    },
    guesses: { p1: null, p2: null }
  },
  player: {
    pc: null,
    channel: null
  }
};

const $ = (selector) => document.querySelector(selector);
const canvas = $("#coastCanvas");
const ctx = canvas.getContext("2d");
const worldCanvas = $("#worldBase");
const worldCtx = worldCanvas.getContext("2d");
const worldMap = $("#worldMap");
const guessPin = $("#guessPin");
const resultLayer = $("#resultLayer");

function log(message) {
  const item = document.createElement("li");
  item.textContent = message;
  $("#logList").prepend(item);
}

function normalizeLongitudeDelta(value) {
  let result = value;
  while (result > 180) result -= 360;
  while (result < -180) result += 360;
  return result;
}

function segmentDistance(lat1, lng1, lat2, lng2) {
  const meanLat = ((lat1 + lat2) / 2) * Math.PI / 180;
  const dx = normalizeLongitudeDelta(lng2 - lng1) * 111.32 * Math.cos(meanLat);
  const dy = (lat2 - lat1) * 111.32;
  return Math.hypot(dx, dy);
}

function parseShapeData(buffer, expectedShapeType) {
  const view = new DataView(buffer);
  const lines = [];
  let offset = 100;

  while (offset + 12 <= buffer.byteLength) {
    const contentBytes = view.getInt32(offset + 4, false) * 2;
    const recordStart = offset + 8;
    const recordEnd = recordStart + contentBytes;

    if (recordEnd > buffer.byteLength) break;
    if (view.getInt32(recordStart, true) === expectedShapeType) {
      const partCount = view.getInt32(recordStart + 36, true);
      const pointCount = view.getInt32(recordStart + 40, true);
      const partsOffset = recordStart + 44;
      const pointsOffset = partsOffset + partCount * 4;

      for (let part = 0; part < partCount; part += 1) {
        const start = view.getInt32(partsOffset + part * 4, true);
        const end = part + 1 < partCount
          ? view.getInt32(partsOffset + (part + 1) * 4, true)
          : pointCount;
        const count = end - start;
        if (count < 2) continue;

        const pointOffset = pointsOffset + start * 16;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        let length = 0;
        let previousLng = view.getFloat64(pointOffset, true);
        let previousLat = view.getFloat64(pointOffset + 8, true);

        minLng = maxLng = previousLng;
        minLat = maxLat = previousLat;

        for (let index = 1; index < count; index += 1) {
          const point = pointOffset + index * 16;
          const lng = view.getFloat64(point, true);
          const lat = view.getFloat64(point + 8, true);
          minLng = Math.min(minLng, lng);
          maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
          length += segmentDistance(previousLat, previousLng, lat, lng);
          previousLng = lng;
          previousLat = lat;
        }

        const lastOffset = pointOffset + (count - 1) * 16;
        const closed =
          Math.abs(view.getFloat64(pointOffset, true) - view.getFloat64(lastOffset, true)) < 1e-8
          && Math.abs(view.getFloat64(pointOffset + 8, true) - view.getFloat64(lastOffset + 8, true)) < 1e-8;

        lines.push({ pointOffset, count, minLng, minLat, maxLng, maxLat, length, closed });
      }
    }

    offset = recordEnd;
  }

  return { buffer, view, lines };
}

function prepareCoastlineSamplingPool(dataset, minimumLengthKm) {
  let totalSamplingWeight = 0;
  const samplingLines = dataset.lines
    .filter((line) => line.length >= minimumLengthKm)
    .map((line) => {
      const samplingWeight = Math.pow(line.length, SAMPLING_WEIGHT_EXPONENT);
      totalSamplingWeight += samplingWeight;
      return { ...line, samplingWeight, cumulativeSamplingWeight: totalSamplingWeight };
    });

  return { ...dataset, samplingLines, totalSamplingWeight };
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seedText) {
  let seed = hashString(seedText) || 1;
  return () => {
    seed += 0x6D2B79F5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function findWeightedLine(target) {
  const lines = state.coast.samplingLines;
  let low = 0;
  let high = lines.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].cumulativeSamplingWeight < target) low = middle + 1;
    else high = middle;
  }
  return lines[low];
}

function randomCoastalPoint(rng) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = rng() * state.coast.totalSamplingWeight;
    const line = findWeightedLine(target);
    let remaining = rng() * line.length;
    const view = state.coast.view;

    for (let index = 1; index < line.count; index += 1) {
      const previous = line.pointOffset + (index - 1) * 16;
      const current = line.pointOffset + index * 16;
      const lng1 = view.getFloat64(previous, true);
      const lat1 = view.getFloat64(previous + 8, true);
      const lng2 = view.getFloat64(current, true);
      const lat2 = view.getFloat64(current + 8, true);
      const length = segmentDistance(lat1, lng1, lat2, lng2);

      if (remaining <= length || index === line.count - 1) {
        const ratio = length > 0 ? Math.min(1, remaining / length) : 0;
        const lngDelta = normalizeLongitudeDelta(lng2 - lng1);
        const lng = normalizeLongitudeDelta(lng1 + lngDelta * ratio);
        const lat = lat1 + (lat2 - lat1) * ratio;
        if (lat < MIN_QUESTION_LATITUDE || lat > MAX_QUESTION_LATITUDE) break;

        const widthKm = DIFFICULTIES[state.difficultyKey].widthKm;
        const offsetXKm = (rng() - 0.5) * widthKm * 0.18;
        const offsetYKm = (rng() - 0.5) * widthKm * 0.12;
        const cosLat = Math.max(0.08, Math.cos(lat * Math.PI / 180));

        return {
          lat,
          lng,
          widthKm,
          centerLat: Math.max(-89, Math.min(89, lat + offsetYKm / 111.32)),
          centerLng: normalizeLongitudeDelta(lng + offsetXKm / (111.32 * cosLat))
        };
      }
      remaining -= length;
    }
  }

  throw new Error("Failed to sample a coastline within the latitude limits.");
}

function projectPointToSize(lng, lat, round, width, height) {
  const kmPerLngDegree = 111.32 * Math.max(0.08, Math.cos(round.centerLat * Math.PI / 180));
  const dx = normalizeLongitudeDelta(lng - round.centerLng) * kmPerLngDegree;
  const dy = (lat - round.centerLat) * 111.32;
  const scale = width / round.widthKm;
  return [width / 2 + dx * scale, height / 2 - dy * scale];
}

function projectedWorldWidth(round, width) {
  const kmPerLngDegree = 111.32 * Math.max(0.08, Math.cos(round.centerLat * Math.PI / 180));
  return 360 * kmPerLngDegree * width / round.widthKm;
}

function longitudeBoundsOverlap(line, centerLng, halfDegrees) {
  const targetMin = centerLng - halfDegrees;
  const targetMax = centerLng + halfDegrees;
  return [-360, 0, 360].some((shift) =>
    line.maxLng + shift >= targetMin && line.minLng + shift <= targetMax
  );
}

function visibleLinesForRound(round, dataset, width = canvas.width, height = canvas.height) {
  const aspect = width / height;
  const halfWidthDegrees = round.widthKm / (2 * 111.32 * Math.max(0.08, Math.cos(round.centerLat * Math.PI / 180)));
  const halfHeightDegrees = round.widthKm / aspect / (2 * 111.32);
  const padding = 1.25;
  const minLat = round.centerLat - halfHeightDegrees * padding;
  const maxLat = round.centerLat + halfHeightDegrees * padding;

  return dataset.lines.filter((line) =>
    line.maxLat >= minLat
    && line.minLat <= maxLat
    && longitudeBoundsOverlap(line, round.centerLng, halfWidthDegrees * padding)
  );
}

function traceLine(context, line, dataset, projector, simplifyPixels = 0, wrapWidthPixels = Infinity, xOffset = 0) {
  const view = dataset.view;
  let previousX = Infinity;
  let previousY = Infinity;
  let started = false;

  for (let index = 0; index < line.count; index += 1) {
    const pointOffset = line.pointOffset + index * 16;
    const lng = view.getFloat64(pointOffset, true);
    const lat = view.getFloat64(pointOffset + 8, true);
    let [x, y] = projector(lng, lat);
    const isLast = index === line.count - 1;

    if (started && Number.isFinite(wrapWidthPixels)) {
      while (x - previousX > wrapWidthPixels / 2) x -= wrapWidthPixels;
      while (x - previousX < -wrapWidthPixels / 2) x += wrapWidthPixels;
    }

    if (
      started
      && !isLast
      && simplifyPixels > 0
      && Math.abs(x - previousX) < simplifyPixels
      && Math.abs(y - previousY) < simplifyPixels
    ) {
      continue;
    }

    if (!started) {
      context.moveTo(x + xOffset, y);
      started = true;
    } else {
      context.lineTo(x + xOffset, y);
    }
    previousX = x;
    previousY = y;
  }

  if (line.closed) context.closePath();
}

function traceWrappedLine(context, line, dataset, projector, simplifyPixels, wrapWidthPixels) {
  [-wrapWidthPixels, 0, wrapWidthPixels].forEach((xOffset) => {
    traceLine(context, line, dataset, projector, simplifyPixels, wrapWidthPixels, xOffset);
  });
}

function calculateLandRatio(round) {
  const aspect = canvas.width / canvas.height;
  const width = LAND_RATIO_SAMPLE_WIDTH;
  const height = Math.round(width / aspect);
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  const visibleLand = visibleLinesForRound(round, state.land, width, height);

  maskContext.fillStyle = "black";
  maskContext.fillRect(0, 0, width, height);
  maskContext.fillStyle = "white";
  maskContext.beginPath();
  visibleLand.forEach((line) => {
    traceWrappedLine(
      maskContext,
      line,
      state.land,
      (lng, lat) => projectPointToSize(lng, lat, round, width, height),
      0.15,
      projectedWorldWidth(round, width)
    );
  });
  maskContext.fill("evenodd");

  const pixels = maskContext.getImageData(0, 0, width, height).data;
  let landPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > 127) landPixels += 1;
  }
  return landPixels / (width * height);
}

function hasBalancedLandAndWater(round) {
  const minimumRatio = DIFFICULTIES[state.difficultyKey].minLandOrWaterRatio;
  const landRatio = calculateLandRatio(round);
  return landRatio >= minimumRatio && landRatio <= 1 - minimumRatio;
}

function makeRandomRounds(seedText) {
  const rng = createSeededRandom(seedText);
  const rounds = [];
  let attempts = 0;

  while (rounds.length < ROUND_COUNT && attempts < 3000) {
    const candidate = randomCoastalPoint(rng);
    const separated = rounds.every((round) => haversine(round, candidate) > MIN_ROUND_SEPARATION_KM);
    if (separated && hasBalancedLandAndWater(candidate)) rounds.push(candidate);
    attempts += 1;
  }

  while (rounds.length < ROUND_COUNT) {
    rounds.push(randomCoastalPoint(rng));
  }
  return rounds;
}

function renderCoast(round) {
  const { width, height } = canvas;
  const wrapWidth = projectedWorldWidth(round, width);
  const visibleCoastlines = visibleLinesForRound(round, state.coast);
  const visibleLand = visibleLinesForRound(round, state.land);
  const ocean = ctx.createLinearGradient(0, 0, width, height);
  ocean.addColorStop(0, "#5b9fac");
  ocean.addColorStop(0.55, "#3e8492");
  ocean.addColorStop(1, "#246b79");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.strokeStyle = "#dff4ef";
  ctx.lineWidth = 2;
  for (let y = 40; y < height; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(width * 0.3, y - 8, width * 0.7, y + 8, width, y);
    ctx.stroke();
  }
  ctx.restore();

  const land = ctx.createLinearGradient(0, 0, width, height);
  land.addColorStop(0, "#b7b886");
  land.addColorStop(0.45, "#7f9669");
  land.addColorStop(1, "#496c58");

  ctx.fillStyle = land;
  ctx.beginPath();
  visibleLand.forEach((line) => {
    traceWrappedLine(ctx, line, state.land, (lng, lat) => projectPointToSize(lng, lat, round, width, height), 0.3, wrapWidth);
  });
  ctx.fill("evenodd");

  ctx.save();
  ctx.strokeStyle = "rgba(242, 226, 176, 0.74)";
  ctx.lineWidth = 18;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  visibleCoastlines.forEach((line) => {
    ctx.beginPath();
    traceWrappedLine(ctx, line, state.coast, (lng, lat) => projectPointToSize(lng, lat, round, width, height), 0.25, wrapWidth);
    ctx.stroke();
  });
  ctx.strokeStyle = "rgba(255, 255, 255, 0.76)";
  ctx.lineWidth = 5;
  visibleCoastlines.forEach((line) => {
    ctx.beginPath();
    traceWrappedLine(ctx, line, state.coast, (lng, lat) => projectPointToSize(lng, lat, round, width, height), 0.2, wrapWidth);
    ctx.stroke();
  });
  ctx.restore();

  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.22, width / 2, height / 2, width * 0.75);
  vignette.addColorStop(0, "rgba(3, 29, 28, 0)");
  vignette.addColorStop(1, "rgba(3, 29, 28, 0.32)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  const scaleKm = Math.max(10, Math.round(round.widthKm / 5 / 10) * 10);
  $("#scaleLabel").textContent = `${scaleKm} KM`;
  $(".scale-bar span").style.width = `${Math.max(42, Math.min(140, (scaleKm / round.widthKm) * 100))}px`;
}

function renderWorldMap() {
  const { width, height } = worldCanvas;
  worldCtx.clearRect(0, 0, width, height);
  worldCtx.fillStyle = "#a7bdb2";
  worldCtx.strokeStyle = "#6f8b80";
  worldCtx.lineWidth = 2;
  worldCtx.lineJoin = "round";

  const projector = (lng, lat) => [
    ((lng + 180) / 360) * width,
    ((90 - lat) / 180) * height
  ];

  worldCtx.beginPath();
  state.land.lines.forEach((line) => traceLine(worldCtx, line, state.land, projector, 1.1));
  worldCtx.fill("evenodd");

  state.coastSource.lines.forEach((line) => {
    worldCtx.beginPath();
    traceLine(worldCtx, line, state.coastSource, projector, 1.1);
    worldCtx.stroke();
  });
}

function latLngToMap(lat, lng) {
  return {
    x: ((lng + 180) / 360) * 1000,
    y: ((90 - lat) / 180) * 500
  };
}

function mapToLatLng(x, y) {
  return {
    lat: 90 - (y / 500) * 180,
    lng: (x / 1000) * 360 - 180
  };
}

function formatCoordinate({ lat, lng }) {
  const latDir = lat >= 0 ? "N" : "S";
  const lngDir = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(3)}° ${latDir}, ${Math.abs(lng).toFixed(3)}° ${lngDir}`;
}

function haversine(a, b) {
  const toRad = (degree) => degree * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(normalizeLongitudeDelta(b.lng - a.lng));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function scoreForDistance(distance) {
  const decayDistance = DIFFICULTIES[state.difficultyKey].scoreDecayDistanceKm;
  return Math.round(MAX_ROUND_SCORE * Math.exp(-distance / decayDistance));
}

function formatTime(milliseconds) {
  return `${String(Math.max(0, Math.ceil(milliseconds / 1000))).padStart(2, "0")}초`;
}

function updateTimerDisplay() {
  if (state.phase !== "playing" || !state.endsAt) {
    $("#roundTimer").textContent = "00초";
    return;
  }
  const remaining = Math.max(0, state.endsAt - Date.now());
  $("#roundTimer").textContent = formatTime(remaining);
  if (remaining === 0 && state.role === "host") finishRound();
}

function startTimer() {
  if (state.timerId) clearInterval(state.timerId);
  updateTimerDisplay();
  state.timerId = setInterval(updateTimerDisplay, 200);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
  updateTimerDisplay();
}

function createSvgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function clearRoundVisuals() {
  resultLayer.replaceChildren();
  guessPin.setAttribute("visibility", "hidden");
  state.guess = null;
  state.submitted = false;
  $("#selectedCoordinates").textContent = "아직 선택하지 않았습니다";
  $("#resetGuess").disabled = true;
}

function renderRound(roundIndex) {
  const round = state.rounds[roundIndex];
  if (!round) return;
  clearRoundVisuals();
  renderCoast(round);
  $("#coastOverlay").classList.add("hidden");
  $("#coastHeading").textContent = state.role === "host" ? "심판 관전 중" : "이 해안선의 위치를 맞히세요";
  $("#fragmentNumber").textContent = `#${String(roundIndex + 1).padStart(2, "0")}`;
  $("#roundNow").textContent = roundIndex + 1;
  $("#roundTotal").textContent = `/${ROUND_COUNT}`;
  setMapEnabled(state.role !== "host" && state.phase === "playing" && !state.submitted);
}

function renderResult(payload) {
  resultLayer.replaceChildren();
  state.lastRound = payload;
  const answerPoint = latLngToMap(payload.answer.lat, payload.answer.lng);
  resultLayer.append(
    createSvgElement("circle", { cx: answerPoint.x, cy: answerPoint.y, r: 16, class: "answer-dot" })
  );

  ["p1", "p2"].forEach((slot) => {
    const guess = payload.guesses[slot];
    if (!guess) return;
    const point = latLngToMap(guess.lat, guess.lng);
    resultLayer.append(
      createSvgElement("path", {
        d: `M ${point.x} ${point.y} L ${answerPoint.x} ${answerPoint.y}`,
        class: `answer-line ${slot}`
      }),
      createSvgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 6,
        class: `player-dot ${slot}`
      }),
      createSvgElement("text", {
        x: point.x + 9,
        y: point.y - 9,
        class: "player-label"
      })
    );
    resultLayer.lastChild.textContent = slot === "p1" ? "1P" : "2P";
  });

  updateRoundResult(payload);
  setMapEnabled(false);
}

function updateRoundResult(payload) {
  $("#roundResult").classList.remove("hidden");
  $("#answerCoordinate").textContent = formatCoordinate(payload.answer);
  ["p1", "p2"].forEach((slot) => {
    const gain = payload.roundScores?.[slot] ?? 0;
    const distance = payload.distances?.[slot];
    $(`#${slot}RoundGain`).textContent = `+${gain.toLocaleString("ko-KR")}`;
    $(`#${slot}RoundDistance`).textContent = distance === null || distance === undefined
      ? "미제출"
      : `${Math.round(distance).toLocaleString("ko-KR")} km`;
  });
}

function setMapEnabled(enabled) {
  $("#mapWrap").classList.toggle("disabled", !enabled);
  $("#submitGuess").disabled = !enabled || !state.guess || state.submitted;
  $("#resetGuess").disabled = !enabled || !state.guess || state.submitted;
  $("#submitLabel").textContent = state.submitted
    ? "제출 완료"
    : enabled
      ? "이 위치로 제출"
      : "라운드 대기 중";
}

function placeGuess(event) {
  if (state.role === "host" || state.phase !== "playing" || state.submitted) return;
  const point = worldMap.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const svgPoint = point.matrixTransform(worldMap.getScreenCTM().inverse());
  const x = Math.max(0, Math.min(1000, svgPoint.x));
  const y = Math.max(0, Math.min(500, svgPoint.y));
  state.guess = mapToLatLng(x, y);
  guessPin.setAttribute("transform", `translate(${x} ${y})`);
  guessPin.setAttribute("visibility", "visible");
  $("#selectedCoordinates").textContent = formatCoordinate(state.guess);
  setMapEnabled(true);
}

function resetGuess() {
  if (state.submitted) return;
  state.guess = null;
  guessPin.setAttribute("visibility", "hidden");
  $("#selectedCoordinates").textContent = "아직 선택하지 않았습니다";
  setMapEnabled(state.role !== "host" && state.phase === "playing");
}

function submitGuess() {
  if (!state.guess || state.submitted || state.role !== "player") return;
  state.submitted = true;
  setMapEnabled(false);
  sendToHost({
    type: "guess",
    slot: state.slot,
    roundIndex: state.roundIndex,
    guess: state.guess,
    submittedAt: Date.now()
  });
  log(`${state.slot === "p1" ? "1P" : "2P"} 추측 제출 완료`);
}

function updateScoreboard() {
  const canStart = canStartMatch();
  const startText = state.phase === "finished" ? "새 10라운드 시작" : "10라운드 시작";
  $("#p1Name").textContent = state.players.p1.nickname;
  $("#p2Name").textContent = state.players.p2.nickname;
  $("#p1Score").textContent = state.scores.p1.toLocaleString("ko-KR");
  $("#p2Score").textContent = state.scores.p2.toLocaleString("ko-KR");
  $("#p1Submit").textContent = submitLabelForSlot("p1");
  $("#p2Submit").textContent = submitLabelForSlot("p2");
  $("#scoreP1").classList.toggle("submitted", state.players.p1.submitted);
  $("#scoreP2").classList.toggle("submitted", state.players.p2.submitted);
  $("#phaseLabel").textContent = state.phase.toUpperCase();
  $("#connectionState").textContent = state.phase === "playing" ? "진행 중" : state.phase === "finished" ? "종료" : "대기";
  $("#startMatch").textContent = startText;
  $("#restartMatch").textContent = startText;
  $("#startMatch").disabled = !canStart;
  $("#restartMatch").disabled = !canStart;
  $("#hostControlText").textContent = hostControlText();
}

function hostControlText() {
  if (state.role !== "host") return "플레이어 화면에서는 방장이 다음 매치를 시작합니다";
  if (state.phase === "playing") return "대전 진행 중입니다";
  if (state.phase === "revealing") return "라운드 결과 공개 중입니다";
  if (state.phase === "finished") return "같은 연결로 새 10라운드를 시작할 수 있습니다";
  if (!state.players.p1.connected || !state.players.p2.connected) return "1P와 2P 연결을 기다리는 중입니다";
  if (!state.players.p1.ready || !state.players.p2.ready) return "두 플레이어의 Ready를 기다리는 중입니다";
  return "대전을 시작할 수 있습니다";
}

function submitLabelForSlot(slot) {
  if (state.phase === "revealing" && state.lastRound?.roundScores) {
    const gain = state.lastRound.roundScores[slot] ?? 0;
    const distance = state.lastRound.distances?.[slot];
    const distanceText = distance === null || distance === undefined
      ? "미제출"
      : `${Math.round(distance).toLocaleString("ko-KR")} km`;
    return `이번 라운드 +${gain} · ${distanceText}`;
  }
  return state.players[slot].submitted ? "제출 완료" : "미제출";
}

function broadcast(message) {
  ["p1", "p2"].forEach((slot) => sendToPlayer(slot, message));
}

function sendToPlayer(slot, message) {
  const channel = state.host.peers[slot].channel;
  if (channel?.readyState === "open") channel.send(JSON.stringify(message));
}

function sendToHost(message) {
  const channel = state.player.channel;
  if (channel?.readyState === "open") channel.send(JSON.stringify(message));
}

function sendLobbyState() {
  const payload = {
    type: "lobby",
    players: state.players,
    scores: state.scores,
    phase: state.phase
  };
  broadcast(payload);
  updateScoreboard();
}

function canStartMatch() {
  return state.role === "host"
    && state.dataReady
    && state.players.p1.connected
    && state.players.p2.connected
    && state.players.p1.ready
    && state.players.p2.ready
    && (state.phase === "lobby" || state.phase === "finished");
}

function startMatch() {
  if (!canStartMatch()) return;
  state.difficultyKey = $("#difficultySelect").value;
  state.coast = prepareCoastlineSamplingPool(
    state.coastSource,
    DIFFICULTIES[state.difficultyKey].minCoastlineLengthKm
  );
  const seed = `${Date.now()}-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
  state.rounds = makeRandomRounds(seed);
  state.roundIndex = -1;
  state.phase = "playing";
  state.scores = { p1: 0, p2: 0 };
  state.lastRound = null;
  state.players.p1.submitted = false;
  state.players.p2.submitted = false;
  $("#hostConnectPanel").classList.add("hidden");
  $("#roundResult").classList.add("hidden");
  log(`대전 시작: ${DIFFICULTIES[state.difficultyKey].label}, 10라운드`);
  broadcast({
    type: "game-start",
    difficultyKey: state.difficultyKey,
    rounds: state.rounds,
    scores: state.scores,
    players: state.players
  });
  nextHostRound();
}

function nextHostRound() {
  state.phase = "playing";
  state.roundIndex += 1;
  if (state.roundIndex >= ROUND_COUNT) {
    finishMatch();
    return;
  }

  state.host.guesses = { p1: null, p2: null };
  state.lastRound = null;
  state.players.p1.submitted = false;
  state.players.p2.submitted = false;
  state.endsAt = Date.now() + ROUND_TIME_MS;
  renderRound(state.roundIndex);
  startTimer();
  broadcast({
    type: "round-start",
    roundIndex: state.roundIndex,
    endsAt: state.endsAt,
    scores: state.scores,
    players: state.players
  });
  sendLobbyState();
  log(`${state.roundIndex + 1}라운드 시작`);
}

function receiveHostGuess(slot, guess) {
  if (state.phase !== "playing" || state.host.guesses[slot]) return;
  state.host.guesses[slot] = guess;
  state.players[slot].submitted = true;
  broadcast({ type: "player-submit", slot, roundIndex: state.roundIndex, players: state.players });
  updateScoreboard();
  log(`${slot === "p1" ? "1P" : "2P"} 제출 수신`);
  if (state.host.guesses.p1 && state.host.guesses.p2) finishRound();
}

function finishRound() {
  if (state.phase !== "playing") return;
  state.phase = "revealing";
  stopTimer();
  const answer = state.rounds[state.roundIndex];
  const guesses = {
    p1: state.host.guesses.p1,
    p2: state.host.guesses.p2
  };
  const distances = { p1: null, p2: null };
  const roundScores = { p1: 0, p2: 0 };

  ["p1", "p2"].forEach((slot) => {
    if (!guesses[slot]) return;
    distances[slot] = haversine(guesses[slot], answer);
    roundScores[slot] = scoreForDistance(distances[slot]);
    state.scores[slot] += roundScores[slot];
  });

  state.players.p1.submitted = Boolean(guesses.p1);
  state.players.p2.submitted = Boolean(guesses.p2);
  const payload = {
    type: "round-result",
    roundIndex: state.roundIndex,
    answer: { lat: answer.lat, lng: answer.lng },
    guesses,
    distances,
    roundScores,
    scores: state.scores,
    players: state.players
  };
  state.lastRound = payload;
  renderResult(payload);
  updateScoreboard();
  broadcast(payload);
  log(`${state.roundIndex + 1}라운드 결과: 1P +${roundScores.p1}, 2P +${roundScores.p2}`);

  setTimeout(() => {
    if (state.phase === "revealing") nextHostRound();
  }, 5200);
}

function finishMatch() {
  state.phase = "finished";
  stopTimer();
  const winner = state.scores.p1 === state.scores.p2
    ? "무승부"
    : state.scores.p1 > state.scores.p2
      ? "1P 승리"
      : "2P 승리";
  state.players.p1.submitted = false;
  state.players.p2.submitted = false;
  broadcast({ type: "game-over", scores: state.scores, winner });
  $("#startMatch").classList.remove("hidden");
  updateScoreboard();
  setMapEnabled(false);
  $("#coastHeading").textContent = `대전 종료 · ${winner}`;
  log(`대전 종료: ${winner} (${state.scores.p1} : ${state.scores.p2})`);
}

function handleHostMessage(slot, message) {
  if (message.type === "hello") {
    state.players[slot] = {
      ...state.players[slot],
      nickname: message.nickname || (slot === "p1" ? "1P" : "2P"),
      connected: true
    };
    sendToPlayer(slot, { type: "peer-accepted", slot, players: state.players });
    sendLobbyState();
    log(`${slot === "p1" ? "1P" : "2P"} 연결됨`);
  }
  if (message.type === "ready") {
    state.players[slot].ready = Boolean(message.ready);
    sendLobbyState();
    log(`${slot === "p1" ? "1P" : "2P"} Ready`);
  }
  if (message.type === "guess" && message.roundIndex === state.roundIndex) {
    receiveHostGuess(slot, message.guess);
  }
}

function handlePlayerMessage(message) {
  if (message.type === "peer-accepted") {
    state.slot = message.slot;
    applyLobbyState(message);
    $("#readyButton").disabled = false;
    log("방장과 연결되었습니다. Ready를 누르면 대기 완료됩니다.");
  }
  if (message.type === "lobby") applyLobbyState(message);
  if (message.type === "game-start") {
    $("#playerConnectPanel").classList.add("hidden");
    $("#roundResult").classList.add("hidden");
    state.difficultyKey = message.difficultyKey;
    state.coast = prepareCoastlineSamplingPool(
      state.coastSource,
      DIFFICULTIES[state.difficultyKey].minCoastlineLengthKm
    );
    state.rounds = message.rounds;
    state.scores = message.scores;
    state.players = message.players;
    state.phase = "playing";
    state.lastRound = null;
    updateScoreboard();
    log("대전이 시작되었습니다.");
  }
  if (message.type === "round-start") {
    state.phase = "playing";
    state.lastRound = null;
    state.roundIndex = message.roundIndex;
    state.endsAt = message.endsAt;
    state.scores = message.scores;
    state.players = message.players;
    state.players.p1.submitted = false;
    state.players.p2.submitted = false;
    renderRound(state.roundIndex);
    startTimer();
    updateScoreboard();
    log(`${state.roundIndex + 1}라운드 시작`);
  }
  if (message.type === "player-submit") {
    state.players = message.players;
    updateScoreboard();
  }
  if (message.type === "round-result") {
    state.phase = "revealing";
    stopTimer();
    state.scores = message.scores;
    state.players = message.players;
    state.lastRound = message;
    renderResult(message);
    updateScoreboard();
    const myScore = message.roundScores[state.slot];
    const distance = message.distances[state.slot];
    const distanceText = distance === null ? "미제출" : `${Math.round(distance).toLocaleString("ko-KR")} km`;
    log(`라운드 결과: ${distanceText}, +${myScore}점`);
  }
  if (message.type === "game-over") {
    state.phase = "finished";
    state.scores = message.scores;
    state.players.p1.submitted = false;
    state.players.p2.submitted = false;
    stopTimer();
    updateScoreboard();
    setMapEnabled(false);
    $("#coastHeading").textContent = `대전 종료 · ${message.winner}`;
    log(`대전 종료: ${message.winner}`);
  }
}

function applyLobbyState(message) {
  state.players = message.players || state.players;
  state.scores = message.scores || state.scores;
  state.phase = message.phase || state.phase;
  updateScoreboard();
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function compactSdp(sdp) {
  return sdp
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^a=candidate:.*\stcp\s/iu.test(line))
    .filter((line) => line !== "a=end-of-candidates")
    .filter((line) => line !== "a=ice-options:trickle")
    .join("\r\n")
    + "\r\n";
}

function compactDescription(value) {
  return value?.sdp ? [value.type, compactSdp(value.sdp)] : value;
}

function expandDescription(value) {
  if (Array.isArray(value) && value.length === 2) {
    return { type: value[0], sdp: value[1] };
  }
  return value?.t && value?.s ? { type: value.t, sdp: value.s } : value;
}

async function compressText(text, format) {
  if (!("CompressionStream" in window)) return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function decompressText(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).text();
}

async function encodeSignal(value) {
  const text = JSON.stringify(compactDescription(value));
  const rawDeflated = await compressText(text, "deflate-raw");
  if (rawDeflated) return `R.${bytesToBase64Url(rawDeflated)}`;
  const deflated = await compressText(text, "deflate");
  if (deflated) return `D.${bytesToBase64Url(deflated)}`;
  const gzipped = await compressText(text, "gzip");
  if (gzipped) return `G.${bytesToBase64Url(gzipped)}`;
  return `J.${bytesToBase64Url(new TextEncoder().encode(text))}`;
}

async function decodeSignal(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("R.")) {
    return expandDescription(JSON.parse(await decompressText(base64UrlToBytes(trimmed.slice(2)), "deflate-raw")));
  }
  if (trimmed.startsWith("D.")) {
    return expandDescription(JSON.parse(await decompressText(base64UrlToBytes(trimmed.slice(2)), "deflate")));
  }
  if (trimmed.startsWith("G.")) {
    return expandDescription(JSON.parse(await decompressText(base64UrlToBytes(trimmed.slice(2)), "gzip")));
  }
  if (trimmed.startsWith("J.")) {
    return expandDescription(JSON.parse(new TextDecoder().decode(base64UrlToBytes(trimmed.slice(2)))));
  }
  const binary = atob(trimmed);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return expandDescription(JSON.parse(new TextDecoder().decode(bytes)));
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", checkState);
  });
}

function setupChannel(channel, onMessage, onOpen) {
  channel.onopen = () => {
    onOpen?.();
  };
  channel.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch (error) {
      log(`메시지 해석 실패: ${error.message}`);
    }
  };
  channel.onclose = () => log("WebRTC 채널이 닫혔습니다.");
}

async function answerPlayer(slot) {
  const offerField = slot === "p1" ? $("#p1Offer") : $("#p2Offer");
  const answerField = slot === "p1" ? $("#p1Answer") : $("#p2Answer");
  const offer = await decodeSignal(offerField.value);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.host.peers[slot].pc = pc;

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    state.host.peers[slot].channel = channel;
    setupChannel(channel, (message) => handleHostMessage(slot, message), () => {
      sendToPlayer(slot, { type: "peer-accepted", slot, players: state.players });
    });
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);
  answerField.value = await encodeSignal(pc.localDescription);
  log(`${slot === "p1" ? "1P" : "2P"} Answer 생성 완료 (${answerField.value.length.toLocaleString("ko-KR")}자)`);
}

async function createPlayerOffer() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel("coast-duel");
  state.player.pc = pc;
  state.player.channel = channel;

  setupChannel(channel, handlePlayerMessage, () => {
    sendToHost({
      type: "hello",
      slot: state.slot,
      nickname: state.nickname
    });
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  $("#playerOffer").value = await encodeSignal(pc.localDescription);
  log(`Offer 생성 완료 (${ $("#playerOffer").value.length.toLocaleString("ko-KR") }자). 방장에게 전달하세요.`);
}

async function acceptHostAnswer() {
  if (!state.player.pc) return;
  const answer = await decodeSignal($("#playerAnswer").value);
  await state.player.pc.setRemoteDescription(answer);
  log("Answer 적용 완료. 연결을 기다리는 중입니다.");
}

function becomeHost() {
  state.role = "host";
  state.nickname = $("#hostName").value.trim() || "Referee";
  state.difficultyKey = $("#difficultySelect").value;
  $("#setupPanel").classList.add("hidden");
  $("#hostConnectPanel").classList.remove("hidden");
  $("#hostControls").classList.remove("hidden");
  $("#roleLabel").textContent = "방장 / 심판";
  $("#coastHeading").textContent = "플레이어 연결 대기 중";
  log("방장 모드가 열렸습니다. 1P와 2P의 Offer를 받아주세요.");
  updateScoreboard();
}

async function becomePlayer() {
  state.role = "player";
  state.slot = $("#playerSlot").value;
  state.nickname = $("#playerName").value.trim() || (state.slot === "p1" ? "1P" : "2P");
  $("#setupPanel").classList.add("hidden");
  $("#playerConnectPanel").classList.remove("hidden");
  $("#roleLabel").textContent = state.slot === "p1" ? "1P 참가자" : "2P 참가자";
  $("#coastHeading").textContent = "방장 연결 대기 중";
  await createPlayerOffer();
}

function toggleReady() {
  state.readySent = !state.readySent;
  $("#readyButton").textContent = state.readySent ? "Ready 취소" : "Ready";
  sendToHost({ type: "ready", ready: state.readySent });
  log(state.readySent ? "Ready 상태로 전환했습니다." : "Ready를 취소했습니다.");
}

async function initializeData() {
  try {
    const [coastResponse, landResponse] = await Promise.all([
      fetch(COAST_DATA_URL),
      fetch(LAND_DATA_URL)
    ]);
    if (!coastResponse.ok || !landResponse.ok) {
      throw new Error(`HTTP ${coastResponse.status}/${landResponse.status}`);
    }
    const [coastBuffer, landBuffer] = await Promise.all([
      coastResponse.arrayBuffer(),
      landResponse.arrayBuffer()
    ]);
    state.coastSource = parseShapeData(coastBuffer, 3);
    state.coast = prepareCoastlineSamplingPool(
      state.coastSource,
      DIFFICULTIES[state.difficultyKey].minCoastlineLengthKm
    );
    state.land = parseShapeData(landBuffer, 5);
    renderWorldMap();
    state.dataReady = true;
    $("#dataState").textContent = "데이터 준비 완료";
    $("#becomeHost").disabled = false;
    $("#becomePlayer").disabled = false;
    $("#coastOverlay").textContent = "라운드 시작 대기 중";
    log("Natural Earth 해안선 데이터 로드 완료");
  } catch (error) {
    $("#dataState").textContent = "데이터 로드 실패";
    $("#coastOverlay").textContent = "해안선 데이터를 불러오지 못했습니다.";
    log(`데이터 로드 실패: ${error.message}`);
  }
}

$("#becomeHost").addEventListener("click", becomeHost);
$("#becomePlayer").addEventListener("click", becomePlayer);
$("#answerP1").addEventListener("click", () => answerPlayer("p1").catch((error) => log(`1P Answer 실패: ${error.message}`)));
$("#answerP2").addEventListener("click", () => answerPlayer("p2").catch((error) => log(`2P Answer 실패: ${error.message}`)));
$("#acceptHostAnswer").addEventListener("click", () => acceptHostAnswer().catch((error) => log(`Answer 적용 실패: ${error.message}`)));
$("#readyButton").addEventListener("click", toggleReady);
$("#startMatch").addEventListener("click", startMatch);
$("#restartMatch").addEventListener("click", startMatch);
$("#worldMap").addEventListener("click", placeGuess);
$("#resetGuess").addEventListener("click", resetGuess);
$("#submitGuess").addEventListener("click", submitGuess);
$("#resetApp").addEventListener("click", () => window.location.reload());

initializeData();
