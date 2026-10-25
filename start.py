# Run:  python start.py
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

for d in [DATA_DIR, MEDIA_DIR]:
    if not os.path.exists(d):
        os.makedirs(d)


def get_slug(name):
    return re.sub(r"\W+", "_", name).lower()


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == "/api/load":
            query = urllib.parse.parse_qs(parsed_path.query)
            park = query.get("park", ["data"])[0]
            park_slug = get_slug(park)
            file_path = os.path.join(DATA_DIR, f"{park_slug}_public_points.json")

            points = []
            if os.path.exists(file_path):
                with open(file_path, "r", encoding="utf-8") as f:
                    try:
                        points = json.load(f)
                    except json.JSONDecodeError:
                        points = []

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(points).encode("utf-8"))
        else:
            super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length)

        if self.path == "/api/save":
            try:
                payload = json.loads(post_data.decode("utf-8"))
                park_slug = get_slug(payload.get("park", "data"))
                file_path = os.path.join(
                    DATA_DIR, f"{park_slug}_public_points.json"
                )

                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(
                        payload.get("points", []),
                        f,
                        indent=2,
                        ensure_ascii=False,
                    )

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"success"}')
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

        elif self.path == "/api/upload-media":
            try:
                payload = json.loads(post_data.decode("utf-8"))
                filename = payload.get("filename")
                b64_data = payload.get("data")

                if filename and b64_data:
                    file_path = os.path.join(MEDIA_DIR, filename)
                    with open(file_path, "wb") as f:
                        f.write(base64.b64decode(b64_data))

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"success"}')
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            self.send_error(404, "Not found")

    def log_message(self, format, *args):
        # Print server logs to your terminal so you can see if requests succeed
        print(f"[{self.log_date_string()}] {format % args}")


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
    webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()