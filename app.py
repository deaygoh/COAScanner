import json
import os
import re
import sys
import socket
import base64
import io

from flask import Flask, render_template, request, jsonify

try:
    from PIL import Image
except Exception:
    Image = None

os.environ["FLAGS_use_mkldnn"] = "0"

os.environ["FLAGS_enable_pir_api"] = "0"

try:
    from paddleocr import PaddleOCR
except Exception:
    PaddleOCR = None

ocr = None

def get_ocr():
    global ocr

    if ocr is None and PaddleOCR is not None:
        try:
            ocr = PaddleOCR(
                use_doc_orientation_classify=True,
                use_doc_unwarping=True,
                use_textline_orientation=True,
                enable_mkldnn=False
            )
        except Exception as exc:
            print("OCR init failed:", exc)
            return None

    return ocr


# =========================================================
# Configuration
# =========================================================

def resource_path(relative_path):
    if getattr(sys, "frozen", False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))

    return os.path.join(base_path, relative_path)


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)

    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = app_dir()

CERT_FILE = os.path.join(
    BASE_DIR,
    "certs",
    "server.pem"
)

KEY_FILE = os.path.join(
    BASE_DIR,
    "certs",
    "server-key.pem"
)


def get_batch_folder():
    candidates = [
        r"\\productionsvr2\Burnin_Reports\Batch COA",
        os.path.join(BASE_DIR, "COA_Batches"),
        os.path.join(BASE_DIR, "COA Batches"),
    ]

    for folder in candidates:
        try:
            os.makedirs(folder, exist_ok=True)
            return folder
        except OSError:
            continue

    return os.path.join(BASE_DIR, "COA_Batches")


BATCH_FOLDER = get_batch_folder()


def get_ssl_context():
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return (CERT_FILE, KEY_FILE)

    return None


app = Flask(
    __name__,
    template_folder=resource_path("templates"),
    static_folder=resource_path("static")
)


# =========================================================
# Utility functions
# =========================================================

def get_local_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def clean_invoice(invoice):
    invoice = invoice.strip()

    if not re.fullmatch(r"[A-Za-z0-9_-]+", invoice):
        return None

    return invoice


def clean_product_key(product_key):
    """
    Convert:
        abcde fghij klmno pqrst uvwxy

    into:
        ABCDE-FGHIJ-KLMNO-PQRST-UVWXY
    """

    cleaned = re.sub(r"[^A-Za-z0-9]", "", product_key).upper()

    if len(cleaned) != 25:
        return None

    return "-".join(
        cleaned[i:i + 5]
        for i in range(0, 25, 5)
    )


def get_batch_path(invoice):
    return os.path.join(
        BATCH_FOLDER,
        f"{invoice}.json"
    )


# =========================================================
# JSON functions
# =========================================================

def load_batch(invoice):
    path = get_batch_path(invoice)

    if not os.path.exists(path):
        return None

    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)

    except (json.JSONDecodeError, OSError) as error:
        print(f"Could not read {path}: {error}")
        return None


def save_batch(invoice, data):
    path = get_batch_path(invoice)
    temp_path = path + ".tmp"

    with open(temp_path, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=4)

    os.replace(temp_path, path)


# =========================================================
# COA functions
# =========================================================

def add_key(invoice, product_key):
    invoice = clean_invoice(invoice)

    if invoice is None:
        return False, "Invalid invoice number."

    product_key = clean_product_key(product_key)

    if product_key is None:
        return False, "Invalid Windows product key."

    data = load_batch(invoice)

    if data is None:
        data = {"keys": []}

    for entry in data["keys"]:
        if entry["product_key"] == product_key:
            return False, "That product key is already in this invoice."

    data["keys"].append({
        "product_key": product_key,
        "serial": None
    })

    save_batch(invoice, data)
    return True, product_key


def assign_key(invoice, serial):
    invoice = clean_invoice(invoice)

    if invoice is None:
        return False, "Invalid invoice number."

    serial = serial.strip()

    if not serial:
        return False, "Serial number cannot be empty."

    data = load_batch(invoice)

    if data is None:
        return False, f"Invoice {invoice} does not exist."

    for entry in data["keys"]:
        if entry["serial"] == serial:
            return True, entry["product_key"]

    for entry in data["keys"]:
        if entry["serial"] is None:
            entry["serial"] = serial
            save_batch(invoice, data)
            return True, entry["product_key"]

    return False, f"No available product keys remain for invoice {invoice}."


# =========================================================
# Web pages
# =========================================================

@app.route("/")
def index():
    return render_template("index.html")


# =========================================================
# API
# =========================================================

@app.route("/api/add-key", methods=["POST"])
def api_add_key():
    data = request.get_json(silent=True) or {}

    invoice = data.get("invoice", "")
    product_key = data.get("product_key", "")

    success, result = add_key(invoice, product_key)

    if not success:
        return jsonify({
            "success": False,
            "message": result
        }), 400

    return jsonify({
        "success": True,
        "product_key": result
    })


@app.route("/api/invoice/<invoice>", methods=["GET"])
def api_invoice(invoice):
    invoice = clean_invoice(invoice)

    if invoice is None:
        return jsonify({
            "success": False,
            "message": "Invalid invoice number."
        }), 400

    data = load_batch(invoice)

    if data is None:
        return jsonify({
            "success": True,
            "exists": False,
            "keys": [],
            "total": 0,
            "available": 0,
            "assigned": 0
        })

    keys = data.get("keys", [])

    assigned = sum(
        1
        for entry in keys
        if entry.get("serial") is not None
    )

    available = len(keys) - assigned

    return jsonify({
        "success": True,
        "exists": True,
        "keys": keys,
        "total": len(keys),
        "available": available,
        "assigned": assigned
    })


@app.route("/api/assign-key", methods=["POST"])
def api_assign_key():
    data = request.get_json(silent=True) or {}

    invoice = data.get("invoice", "")
    serial = data.get("serial", "")

    success, result = assign_key(invoice, serial)

    if not success:
        return jsonify({
            "success": False,
            "message": result
        }), 400

    return jsonify({
        "success": True,
        "product_key": result
    })

def preprocess_image(image):
    """Enhance contrast and sharpness for OCR"""
    from PIL import ImageEnhance
    
    # Increase contrast
    enhancer = ImageEnhance.Contrast(image)
    image = enhancer.enhance(2.0)
    
    # Increase sharpness
    enhancer = ImageEnhance.Sharpness(image)
    image = enhancer.enhance(2.0)
    
    return image

@app.route("/api/scan", methods=["POST"])
def api_scan():
    data = request.get_json(silent=True) or {}

    image_data = data.get("image")

    if not image_data:
        return jsonify({
            "success": False,
            "message": "No image provided."
        })

    if Image is None:
        return jsonify({
            "success": False,
            "message": "Pillow is not available."
        })

    ocr_engine = get_ocr()
    if ocr_engine is None:
        return jsonify({
            "success": False,
            "message": "OCR is not available."
        })

    try:
        encoded = image_data.split(",", 1)[1]
        image_bytes = base64.b64decode(encoded)

        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image = preprocess_image(image)
        temp_file = "_coa_scan.jpg"
        image.save(temp_file)

        results = ocr_engine.predict(temp_file)

        detected_text = []

        for result in results:
            result_data = result.json

            if callable(result_data):
                result_data = result_data()

            def collect_strings(value):
                if isinstance(value, str):
                    detected_text.append(value)
                elif isinstance(value, dict):
                    for item in value.values():
                        collect_strings(item)
                elif isinstance(value, list):
                    for item in value:
                        collect_strings(item)

            collect_strings(result_data)

        full_text = " ".join(detected_text).upper()

        match = re.search(
            r"[A-Z0-9]{5}[-\s]"
            r"[A-Z0-9]{5}[-\s]"
            r"[A-Z0-9]{5}[-\s]"
            r"[A-Z0-9]{5}[-\s]"
            r"[A-Z0-9]{5}",
            full_text
        )

        if not match:
            return jsonify({
                "success": False
            })

        product_key = clean_product_key(match.group(0))

        if product_key is None:
            return jsonify({
                "success": False
            })

        return jsonify({
            "success": True,
            "product_key": product_key,
            "detected_text": full_text
        })

    except Exception as error:
        print("OCR error:", error)
        return jsonify({
            "success": False
        })


# =========================================================
# Start server
# =========================================================

if __name__ == "__main__":
    local_ip = get_local_ip()
    ssl_context = get_ssl_context()
    scheme = "https" if ssl_context else "http"

    print()
    print("COA Manager running.")
    print()
    print("Open on this computer:")
    print(f"{scheme}://127.0.0.1:5000")
    print()
    print("Open on your phone:")
    print(f"{scheme}://{local_ip}:5000")
    print()

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
        ssl_context=ssl_context
    )