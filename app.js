let videoElement = document.getElementById('video');
let startBtn = document.getElementById('startBtn');
let stopBtn = document.getElementById('stopBtn');
let resultText = document.getElementById('resultText');
let testSelect = document.getElementById('testSelect');
let instrText = document.getElementById('instrText');
let statusText = document.getElementById('statusText');
let timerElement = document.getElementById('timer');
let goFlashElement = document.getElementById('go-flash');
let nextBtn = document.getElementById('nextBtn');
let prevBtn = document.getElementById('prevBtn');

const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');

let landmarksHistory = [];
let timestamps = [];
let camera = null;
let running = false;
let timerInterval = null;
let nextPromiseResolve = null;
let earHistory = [];
const EAR_HISTORY_LENGTH = 15;
const EAR_THRESHOLD = 0.22; // Eyes closed threshold

// Instructions
const instructions = {
  "mctisb": `mCTISB Test Instructions:
1. Perform 2 conditions (~30s each):
- Eyes open, firm surface
- Eyes open, foam surface
2. Try to stay as still as possible.`,
  "tug": `TUG Test Instructions:
1. Sit on a chair.
2. Stand up on "Go" command.
3. Walk 3 meters, turn, walk back.
4. Sit down.`,
  "chair": `Chair Stand Test Instructions:
1. Sit on a chair.
2. Stand up and sit back down as many times as possible in 60s.
3. Do not use your arms. Arm assistance will be detected automatically.`
};

testSelect.addEventListener('change', () => {
  instrText.innerText = instructions[testSelect.value];
});

// ===== Helper Functions =====
function hipCenter(landmarks) {
  let left = landmarks[23],
  right = landmarks[24];
  return [(left.x + right.x) / 2, (left.y + right.y) / 2];
}

function wristRelativeToHip(landmarks) {
  let leftWrist = landmarks[15],
  rightWrist = landmarks[19];
  let hip = hipCenter(landmarks);
  return [(leftWrist.y - hip[1]), (rightWrist.y - hip[1])];
}

function rmsDisplacement(coords) {
  let meanX = coords.reduce((sum, c) => sum + c[0], 0) / coords.length;
  let meanY = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
  let sum = coords.reduce((acc, c) => acc + (c[0] - meanX) ** 2 + (c[1] - meanY) ** 2, 0);
  return Math.sqrt(sum / coords.length);
}

function meanVelocity(coords, times) {
  let dist = 0;
  for (let i = 1; i < coords.length; i++) {
    let dx = coords[i][0] - coords[i - 1][0];
    let dy = coords[i][1] - coords[i - 1][1];
    dist += Math.sqrt(dx * dx + dy * dy);
  }
  let dt = times[times.length - 1] - times[0];
  return dt > 0 ? dist / dt : 0;
}

function swayArea(coords) {
  let xs = coords.map(c => c[0]),
  ys = coords.map(c => c[1]);
  let w = Math.max(...xs) - Math.min(...xs);
  let h = Math.max(...ys) - Math.min(...ys);
  return w * h;
}

function updateTimer(secondsElapsed) {
  let minutes = Math.floor(secondsElapsed / 60);
  let seconds = Math.floor(secondsElapsed % 60);
  timerElement.innerText = `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

function startTimer() {
  let startTime = Date.now();
  timerInterval = setInterval(() => {
    let elapsed = (Date.now() - startTime) / 1000;
    updateTimer(elapsed);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerElement.innerText = '00:00';
}

function flashGoMessage() {
  goFlashElement.classList.remove('hidden');
  setTimeout(() => {
    goFlashElement.classList.add('hidden');
  }, 3000);
}

// ===== EAR Functions =====
function computeEAR(landmarks, side) {
  let idx = side === 'left' ? [159, 145, 33, 133, 160, 144] : [386, 374, 263, 362, 387, 373];
  let vertical1 = Math.hypot(landmarks[idx[1]].x - landmarks[idx[0]].x, landmarks[idx[1]].y - landmarks[idx[0]].y);
  let vertical2 = Math.hypot(landmarks[idx[5]].x - landmarks[idx[4]].x, landmarks[idx[5]].y - landmarks[idx[4]].y);
  let horizontal = Math.hypot(landmarks[idx[3]].x - landmarks[idx[2]].x, landmarks[idx[3]].y - landmarks[idx[2]].y);
  return (vertical1 + vertical2) / (2 * horizontal);
}

function eyesAreOpen(landmarks) {
  const leftEAR = computeEAR(landmarks, 'left');
  const rightEAR = computeEAR(landmarks, 'right');
  const avgEAR = (leftEAR + rightEAR) / 2;
  earHistory.push(avgEAR);
  if (earHistory.length > EAR_HISTORY_LENGTH) earHistory.shift();
  const meanEAR = earHistory.reduce((a, b) => a + b, 0) / earHistory.length;
  return meanEAR > EAR_THRESHOLD;
}

// ===== MediaPipe Setup =====
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5/${file}`
});
pose.setOptions({
  modelComplexity: 1,
  smoothLandmarks: true,
  enableSegmentation: false,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});
pose.onResults(onResults);

camera = new Camera(videoElement, {
  onFrame: async () => await pose.send({
    image: videoElement
  }),
  width: 640,
  height: 480
});

// ===== Start/Stop =====
startBtn.addEventListener('click', async () => {
  running = true;
  landmarksHistory = [];
  timestamps = [];
  earHistory = [];
  startBtn.disabled = true;
  stopBtn.disabled = false;
  resultText.innerText = "Results will appear here.";
  nextBtn.classList.add('hidden');
  prevBtn.classList.add('hidden');
  goFlashElement.classList.add('hidden');

  if (testSelect.value === 'mctisb') await runMCTISB();
  else if (testSelect.value === 'tug') await runTUG();
  else if (testSelect.value === 'chair') await runChairStand();
});

stopBtn.addEventListener('click', () => {
  running = false;
  if (camera) camera.stop();
  stopTimer();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  nextBtn.classList.add('hidden');
  prevBtn.classList.add('hidden');
  goFlashElement.classList.add('hidden');
  statusText.innerText = "Test stopped";
});

// ===== mCTISB =====
async function runMCTISB() {
  // Updated to only include eyes open conditions
  let conditions = ["Eyes open, firm surface", "Eyes open, foam surface"];
  let results = [];
  camera.start();
  for (let i = 0; i < conditions.length && running; i++) {
    landmarksHistory = [];
    timestamps = [];
    earHistory = [];
    let condition = conditions[i];
    statusText.innerText = `Current Condition: ${condition}`;
    flashGoMessage();
    await new Promise(res => setTimeout(res, 3000));
    startTimer();
    let startTime = Date.now();

    // Run for 30s
    await new Promise(res => {
      function checkFrame() {
        if (!running) {
          res();
          return;
        }
        if (Date.now() - startTime >= 30000) {
          res();
          return;
        }
        requestAnimationFrame(checkFrame);
      }
      checkFrame();
    });

    stopTimer();
    let coords = landmarksHistory.map(f => hipCenter(f));
    let times = timestamps;
    results.push({
      condition,
      sway: swayArea(coords).toFixed(4),
      rms: rmsDisplacement(coords).toFixed(4),
      velocity: meanVelocity(coords, times).toFixed(4)
    });

    let text = "mCTISB Test Results:\n";
    results.forEach(r => {
      text += `\n${r.condition}:\nSway Area: ${r.sway}\nRMS Displacement: ${r.rms}\nMean Velocity: ${r.velocity}\n`;
    });
    resultText.innerText = text;
  }
  camera.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (running) statusText.innerText = "mCTISB Test Completed";
  running = false;
  stopTimer();
}

// ===== TUG Test =====
async function runTUG() {
  landmarksHistory = [];
  timestamps = [];
  earHistory = [];
  camera.start();

  statusText.innerText = "TUG Test: Sit on a chair. Press 'Start' to begin.";

  // Wait for the user to press start again after instructions
  await new Promise(resolve => {
    const startListener = () => {
      startBtn.removeEventListener('click', startListener);
      resolve();
    };
    startBtn.addEventListener('click', startListener);
  });

  statusText.innerText = "TUG Test: Stand up on 'GO!'";
  flashGoMessage();
  await new Promise(r => setTimeout(r, 3000));

  startTimer();
  let startTime = Date.now();
  let totalTime = 0; // Variable to store the final time
  let state = "sitting";
  let initialHipY = 0;
  let standingThreshold = 0.5;
  let sittingThreshold = 0.7;

  await new Promise(res => {
    function loop() {
      if (!running) {
        res();
        return;
      }

      let landmarkCount = landmarksHistory.length;
      if (landmarkCount > 0) {
        let currentHip = hipCenter(landmarksHistory[landmarkCount - 1]);
        let status_message = "";

        // Calibrate initial hip Y position when the test starts
        if (state === "sitting" && initialHipY === 0) {
          initialHipY = currentHip[1];
        }

        let elapsed = (Date.now() - startTime) / 1000;
        updateTimer(elapsed);

        // State transitions based on hip position
        if (state === "sitting") {
          status_message = "Sitting...";
          if (currentHip[1] < initialHipY - 0.1) {
            state = "standing";
          }
        } else if (state === "standing") {
          status_message = "Standing...";
          if (currentHip[1] < standingThreshold) {
            // This is a placeholder for walking/turning.
            // A more robust solution would track horizontal movement.
            state = "walking_and_turning";
          }
        } else if (state === "walking_and_turning") {
          status_message = "Walking and turning...";
          if (currentHip[1] > sittingThreshold) {
            state = "sitting_again";
          }
        } else if (state === "sitting_again") {
          status_message = "Sitting down...";
          totalTime = elapsed; // Capture the final elapsed time
          res(); // End the test
          return;
        }

        statusText.innerText = status_message;

        resultText.innerText = `TUG Results:\nState: ${state}`;
      }
      requestAnimationFrame(loop);
    }
    loop();
  });

  stopTimer();
  camera.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusText.innerText = "TUG Test Completed";
  resultText.innerText = `TUG Results:\nTotal Time: ${totalTime.toFixed(2)} seconds`; // Display the final time
  running = false;
}

// ===== Chair Stand =====
async function runChairStand() {
  landmarksHistory = [];
  timestamps = [];
  earHistory = [];
  camera.start();
  statusText.innerText = "Chair Stand Test (60s)";
  resultText.innerText = "Reps: 0, Assisted: 0";
  flashGoMessage();
  await new Promise(r => setTimeout(r, 3000));
  startTimer();
  let startTime = Date.now();

  let reps = 0,
  assisted = 0,
  sitting = true,
  sitThreshold = 0.7,
  standThreshold = 0.5;

  await new Promise(res => {
    function loop() {
      if (!running) {
        res();
        return;
      }
      if (landmarksHistory.length > 0) {
        let hip = hipCenter(landmarksHistory[landmarksHistory.length - 1]);
        let elapsed = (Date.now() - startTime) / 1000;
        updateTimer(elapsed);
        if (sitting && hip[1] < standThreshold) {
          reps++;
          sitting = false;
          let [lw, rw] = wristRelativeToHip(landmarksHistory[landmarksHistory.length - 1]);
          if (lw < 0.05 || rw < 0.05) assisted++;
        } else if (!sitting && hip[1] > sitThreshold) {
          sitting = true;
        }
        resultText.innerText = `Chair Stand Results:\nRepetitions: ${reps}\nAssisted: ${assisted}`;
        if (elapsed > 60) {
          res();
          return;
        }
      }
      requestAnimationFrame(loop);
    }
    loop();
  });

  stopTimer();
  camera.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusText.innerText = "Chair Stand Test Completed";
}

// ===== MediaPipe Callback =====
function onResults(results) {
  if (!running) return;
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  if (results.poseLandmarks) {
    landmarksHistory.push(results.poseLandmarks);
    timestamps.push(Date.now() / 1000);
    drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {
      color: '#00FF00',
      lineWidth: 4
    });
    drawLandmarks(canvasCtx, results.poseLandmarks, {
      color: '#FF0000',
      lineWidth: 2
    });
  }
  canvasCtx.restore();
}