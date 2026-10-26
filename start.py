import base64
import functools
import http.server
import json
import os
import re
import urllib.parse
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "saved_data")
MEDIA_DIR = os.path.join(ROOT, "media")
MAX_BODY = 300 * 1024 * 1024  # 300 MB per request (base64 media uploads)

for d in (DATA_DIR, MEDIA_DIR):
    os.makedirs(d, exist_ok=True)


def get_slug(name):
    # ASCII-only so it matches the slug() function in app.js
    return re.sub(r"\W+", "_", str(name), flags=re.ASCII).lower()


def points_path(park):
    return os.path.join(DATA_DIR, f"{get_slug(park)}_public_points.json")


def safe_filename(name):
    """Strip any directory part and unsafe characters (prevents path traversal)."""
    name = os.path.basename(str(name).replace("\\", "/"))
    name = re.sub(r"[^\w.\- ]+", "_", name).strip(" .")
    return name or "file"


def unique_media_path(filename, data):
    """Return (final_name, already_exists_with_same_content)."""
    base, ext = os.path.splitext(filename)
    candidate, n = filename, 1
    while os.path.exists(os.path.join(MEDIA_DIR, candidate)):
        with open(os.path.join(MEDIA_DIR, candidate), "rb") as f:
            if f.read() == data:
                return candidate, True
        candidate = f"{base}_{n}{ext}"
        n += 1
    return candidate, False


def write_atomic(path, data, mode="wb"):
    tmp = path + ".tmp"
    kwargs = {"encoding": "utf-8"} if "b" not in mode else {}
    with open(tmp, mode, **kwargs) as f:
        f.write(data)
    os.replace(tmp, path)


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/load":
            park = urllib.parse.parse_qs(parsed.query).get("park", ["data"])[0]
            points = []
            path = points_path(park)
            if os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        points = json.load(f)
                except (json.JSONDecodeError, OSError):
                    points = []
            self.send_json(points)
        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            self.send_json({"error": "file too large"}, 413)
            return
        raw = self.rfile.read(length)

        try:
            payload = json.loads(raw.decode("utf-8"))

            if self.path == "/api/save":
                points = payload.get("points", [])
                if not isinstance(points, list):
                    raise ValueError("points must be a list")
                text = json.dumps(points, indent=2, ensure_ascii=False)
                write_atomic(points_path(payload.get("park", "data")), text, "w")
                self.send_json({"status": "success", "count": len(points)})

            elif self.path == "/api/upload-media":
                filename = safe_filename(payload.get("filename", ""))
                data = base64.b64decode(payload.get("data", ""))
                if not data:
                    raise ValueError("empty file")
                final, same = unique_media_path(filename, data)
                if not same:
                    write_atomic(os.path.join(MEDIA_DIR, final), data)
                self.send_json({"status": "success", "filename": final})

            else:
                self.send_error(404, "Not found")
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")


def main():
    handler = functools.partial(CustomHandler, directory=ROOT)
    httpd = None
    for port in range(8000, 8020):
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit("No free port between 8000 and 8019.")
    url = "http://127.0.0.1:%d/index.html" % port
    print("Map running at", url, "(press Ctrl+C to stop)")
    print("Points are saved in:", DATA_DIR)
    print("Media is saved in:  ", MEDIA_DIR)
    webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
