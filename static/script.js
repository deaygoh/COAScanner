const invoiceInput =
    document.getElementById("invoice");

const productKeyInput =
    document.getElementById("productKey");

const saveButton =
    document.getElementById("saveButton");

const message =
    document.getElementById("message");

const keyList =
    document.getElementById("keyList");

const emptyMessage =
    document.getElementById("emptyMessage");

const totalCount =
    document.getElementById("totalCount");

const availableCount =
    document.getElementById("availableCount");

const assignedCount =
    document.getElementById("assignedCount");

const camera =
    document.getElementById("camera");

const scanButton =
    document.getElementById("scanButton");


let loadTimer = null;

let cameraStream = null;
let scannerRunning = false;

const scanCanvas =
    document.createElement("canvas");

const scanContext =
    scanCanvas.getContext("2d");


// ========================================================
// Product-key formatting
// ========================================================

function formatProductKey(value) {

    let cleaned = value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 25);

    const groups = [];

    for (
        let i = 0;
        i < cleaned.length;
        i += 5
    ) {
        groups.push(
            cleaned.substring(i, i + 5)
        );
    }

    return groups.join("-");
}


productKeyInput.addEventListener(
    "input",
    function () {

        productKeyInput.value =
            formatProductKey(
                productKeyInput.value
            );

    }
);


// ========================================================
// Status messages
// ========================================================

function showMessage(text, type = "normal") {

    message.textContent = text;

    message.className =
        "message " + type;

}


function clearMessage() {

    message.textContent = "";

    message.className = "message";

}


// ========================================================
// Camera
// ========================================================

async function startScanner() {

    if (scannerRunning)
        return;

    candidateSequence = [];

    try {

        showMessage(
            "Requesting camera...",
            "normal"
        );

        if (
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getUserMedia
        ) {
            throw new Error(
                "getUserMedia is not available in this browser."
            );
        }


        cameraStream =
            await navigator.mediaDevices.getUserMedia({

                video: {
                    facingMode: {
                        ideal: "environment"
                    },
                    width: {
                        ideal: 1920
                    },
                    height: {
                        ideal: 1080
                    }
                },

                audio: false

            });

        // Keep close-up COA text in focus when the phone/browser exposes
        // continuous autofocus controls.
        const videoTrack = cameraStream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities
            ? videoTrack.getCapabilities()
            : {};

        if (
            capabilities.focusMode &&
            capabilities.focusMode.includes("continuous")
        ) {
            try {
                await videoTrack.applyConstraints({
                    advanced: [{
                        focusMode: "continuous"
                    }]
                });
            }
            catch (focusError) {
                console.debug(
                    "Continuous autofocus unavailable:",
                    focusError
                );
            }
        }


        console.log(
            "Camera stream:",
            cameraStream
        );

        console.log(
            "Video tracks:",
            cameraStream.getVideoTracks()
        );


        camera.srcObject =
            cameraStream;


        await camera.play();


        console.log(
            "Video size:",
            camera.videoWidth,
            camera.videoHeight
        );


        scannerRunning = true;

        scanButton.textContent =
            "Stop Scanner";


        showMessage(
            "Camera running.",
            "success"
        );


        scanLoop();

    }

    catch (error) {

        console.error(
            "CAMERA ERROR:",
            error
        );

        showMessage(
            error.name +
            ": " +
            error.message,
            "error"
        );

    }

}


function stopScanner() {

    scannerRunning = false;


    if (cameraStream) {

        const tracks =
            cameraStream.getTracks();

        for (const track of tracks) {
            track.stop();
        }

    }


    cameraStream = null;

    camera.srcObject = null;

    scanButton.textContent =
        "Start Scanner";

}


scanButton.addEventListener(
    "click",
    function () {

        if (scannerRunning) {
            stopScanner();
        }
        else {
            startScanner();
        }

    }
);


// ========================================================
// Live scanning loop
// ========================================================

let candidateSequence = [];

const keyGroupPattern =
    /(?<![B-DF-HJ-NP-TV-Z2346789])([B-DF-HJ-NP-TV-Z2346789]{5})(?![B-DF-HJ-NP-TV-Z2346789])/g;


function extractCandidateGroups(text) {

    return Array.from(
        text.toUpperCase().matchAll(keyGroupPattern),
        match => match[1]
    );

}


function mergeCandidateGroups(current, incoming) {

    if (current.length === 0) {
        return incoming.slice();
    }

    const maxOverlap = Math.min(
        current.length,
        incoming.length
    );

    for (let size = maxOverlap; size > 0; size--) {
        const currentTail = current.slice(-size);
        const incomingHead = incoming.slice(0, size);

        if (currentTail.every(
            (group, index) => group === incomingHead[index]
        )) {
            return current.concat(incoming.slice(size)).slice(-5);
        }
    }

    // Do not combine unrelated fragments; start a fresh candidate chain.
    return incoming.slice(-5);

}

async function scanLoop() {

    while (scannerRunning) {

        if (
            camera.readyState >= 2 &&
            camera.videoWidth > 0 &&
            camera.videoHeight > 0
        ) {

            await scanFrame();

        }

        // scanFrame waits for the server response, so only a short pause is
        // needed to let the browser update between OCR requests.
        await new Promise(resolve => setTimeout(resolve, 25));

    }

}


// ========================================================
// Capture and send one frame
// ========================================================

async function scanFrame() {

    const videoWidth = camera.videoWidth;
    const videoHeight = camera.videoHeight;

    if (videoWidth === 0 || videoHeight === 0) {
        return;
    }

    const videoRect = camera.getBoundingClientRect();
    const guide = document.querySelector(".scan-guide");
    const guideRect = guide.getBoundingClientRect();

    // Size of the video element on screen
    const displayWidth = videoRect.width;
    const displayHeight = videoRect.height;

    // Native camera aspect ratio
    const videoAspect = videoWidth / videoHeight;
    const displayAspect = displayWidth / displayHeight;

    let renderedWidth;
    let renderedHeight;
    let offsetX = 0;
    let offsetY = 0;

    // Reproduce object-fit: cover
    if (videoAspect > displayAspect) {

        // Video is wider than the display area.
        // Height fits; left/right are cropped.
        renderedHeight = displayHeight;
        renderedWidth = displayHeight * videoAspect;

        offsetX =
            (renderedWidth - displayWidth) / 2;
    }
    else {

        // Video is taller than the display area.
        // Width fits; top/bottom are cropped.
        renderedWidth = displayWidth;
        renderedHeight = displayWidth / videoAspect;

        offsetY =
            (renderedHeight - displayHeight) / 2;
    }


    // Guide coordinates relative to the video element
    const guideX =
        guideRect.left - videoRect.left;

    const guideY =
        guideRect.top - videoRect.top;

    const guideWidth =
        guideRect.width;

    const guideHeight =
        guideRect.height;


    // Convert displayed coordinates into coordinates
    // in the full rendered camera image.
    const renderedGuideX =
        guideX + offsetX;

    const renderedGuideY =
        guideY + offsetY;


    // Scale from rendered image pixels
    // back to native camera pixels.
    const scaleX =
        videoWidth / renderedWidth;

    const scaleY =
        videoHeight / renderedHeight;


    const cropX =
        renderedGuideX * scaleX;

    const cropY =
        renderedGuideY * scaleY;

    const cropWidth =
        guideWidth * scaleX;

    const cropHeight =
        guideHeight * scaleY;


    // Resize crop for OCR
    // Preserve fine character edges for the small, reflective COA print.
    const outputWidth = 1000;

    const scale =
        outputWidth / cropWidth;

    const outputHeight =
        Math.round(cropHeight * scale);


    scanCanvas.width =
        outputWidth;

    scanCanvas.height =
        outputHeight;


    scanContext.clearRect(
        0,
        0,
        outputWidth,
        outputHeight
    );


    scanContext.drawImage(
        camera,

        cropX,
        cropY,
        cropWidth,
        cropHeight,

        0,
        0,
        outputWidth,
        outputHeight
    );


    const image =
        scanCanvas.toDataURL(
            "image/jpeg",
            0.7
        );


    try {

        const response =
            await fetch(
                "/api/scan",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        image: image
                    })
                }
            );


        const data =
            await response.json();

        console.log("Backend response:", data);

        // If backend found a key, use it immediately
        if (data.success && data.product_key) {
            console.log("Setting product key to:", data.product_key);
            productKeyInput.value = data.product_key;
            console.log("Input value after set:", productKeyInput.value);
            showMessage("COA detected.", "success");
            
            if (navigator.vibrate) {
                navigator.vibrate(100);
            }
            
            stopScanner();
            candidateSequence = [];
            return;
        }

        // Otherwise, retain overlapping five-character candidates.
        if (data.detected_text) {
            const frameCandidates =
                extractCandidateGroups(data.detected_text);

            if (frameCandidates.length > 0) {
                candidateSequence = mergeCandidateGroups(
                    candidateSequence,
                    frameCandidates
                );

                console.log(
                    "Candidate key groups:",
                    candidateSequence
                );

                if (candidateSequence.length === 5) {
                    productKeyInput.value =
                        candidateSequence.join("-");
                    showMessage("COA detected across frames.", "success");

                    if (navigator.vibrate) {
                        navigator.vibrate(100);
                    }

                    stopScanner();
                    candidateSequence = [];
                    return;
                }
            }
        }

    }
    catch (error) {

        console.error(
            "SCAN ERROR:",
            error
        );

    }

}


// ========================================================
// Load invoice
// ========================================================

async function loadInvoice() {

    const invoice =
        invoiceInput.value.trim();


    if (!invoice) {

        keyList.innerHTML = "";

        emptyMessage.textContent =
            "Enter an invoice number to begin.";

        emptyMessage.style.display =
            "block";

        totalCount.textContent =
            "0";

        availableCount.textContent =
            "0";

        assignedCount.textContent =
            "0";

        return;

    }


    try {

        const response =
            await fetch(
                "/api/invoice/" +
                encodeURIComponent(
                    invoice
                )
            );


        const data =
            await response.json();


        if (!data.success) {

            showMessage(
                data.message,
                "error"
            );

            return;
        }


        totalCount.textContent =
            data.total;

        availableCount.textContent =
            data.available;

        assignedCount.textContent =
            data.assigned;


        keyList.innerHTML = "";


        if (
            !data.keys ||
            data.keys.length === 0
        ) {

            emptyMessage.textContent =
                "No COAs have been added to this invoice yet.";

            emptyMessage.style.display =
                "block";

            return;

        }


        emptyMessage.style.display =
            "none";


        for (const entry of data.keys) {

            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "key-item";


            const key =
                document.createElement(
                    "div"
                );

            key.className =
                "key-value";

            key.textContent =
                entry.product_key;


            const status =
                document.createElement(
                    "div"
                );

            status.className =
                "key-status";


            if (
                entry.serial === null
            ) {

                status.textContent =
                    "Available";

                status.classList.add(
                    "available"
                );

            }

            else {

                status.textContent =
                    "Assigned: " +
                    entry.serial;

                status.classList.add(
                    "assigned"
                );

            }


            item.appendChild(
                key
            );

            item.appendChild(
                status
            );

            keyList.appendChild(
                item
            );

        }

    }

    catch (error) {

        console.error(
            "LOAD INVOICE ERROR:",
            error
        );

        showMessage(
            "Could not reach the server.",
            "error"
        );

    }

}


// ========================================================
// Save COA
// ========================================================

async function saveKey() {

    clearMessage();


    const invoice =
        invoiceInput.value.trim();

    const productKey =
        productKeyInput.value.trim();


    if (!invoice) {

        showMessage(
            "Enter an invoice number.",
            "error"
        );

        invoiceInput.focus();

        return;

    }


    if (!productKey) {

        showMessage(
            "Enter or scan a product key.",
            "error"
        );

        productKeyInput.focus();

        return;

    }


    if (
        productKey.length !== 29
    ) {

        showMessage(
            "Product key is incomplete.",
            "error"
        );

        productKeyInput.focus();

        return;

    }


    saveButton.disabled = true;


    try {

        const response =
            await fetch(
                "/api/add-key",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            invoice:
                                invoice,

                            product_key:
                                productKey
                        })
                }
            );


        const data =
            await response.json();


        if (!data.success) {

            showMessage(
                data.message,
                "error"
            );

            return;

        }


        showMessage(
            "COA saved.",
            "success"
        );


        productKeyInput.value =
            "";


        await loadInvoice();


        // Restart camera automatically
        // after saving, if you want to
        // continue scanning more COAs.

        setTimeout(
            function () {

                if (!scannerRunning) {
                    startScanner();
                }

            },
            400
        );

    }

    catch (error) {

        console.error(
            "SAVE ERROR:",
            error
        );

        showMessage(
            "Could not reach the server.",
            "error"
        );

    }

    finally {

        saveButton.disabled =
            false;

    }

}


// ========================================================
// Save button
// ========================================================

saveButton.addEventListener(
    "click",
    saveKey
);


// Allow Enter to save
productKeyInput.addEventListener(
    "keydown",
    function (event) {

        if (event.key === "Enter") {
            saveKey();
        }

    }
);


// ========================================================
// Invoice handling
// ========================================================

invoiceInput.addEventListener(
    "input",
    function () {

        clearTimeout(
            loadTimer
        );


        loadTimer =
            setTimeout(
                loadInvoice,
                300
            );

    }
);


invoiceInput.addEventListener(
    "change",
    function () {

        localStorage.setItem(
            "lastInvoice",
            invoiceInput.value.trim()
        );

    }
);


// ========================================================
// Restore last invoice after reload
// ========================================================

const storedInvoice =
    localStorage.getItem(
        "lastInvoice"
    );


if (storedInvoice) {

    invoiceInput.value =
        storedInvoice;

    loadInvoice();

}
