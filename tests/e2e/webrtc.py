"""Appel WebRTC réel entre deux softphones web (Chromium, micro simulé) à travers Nginx et Asterisk.
   python3 webrtc.py <base_url> <poste_A> <mdp_A> <poste_B> <mdp_B>"""
import sys
from playwright.sync_api import sync_playwright

base, a_ext, a_pw, b_ext, b_pw = sys.argv[1:6]
def log(m): print(m, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    pages = {}
    for ext, pw in ((a_ext, a_pw), (b_ext, b_pw)):
        ctx = browser.new_context(permissions=["microphone"])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e, ext=ext: log(f"[{ext}] erreur JS : {e}"))
        pg.goto(f"{base}/softphone")
        pg.wait_for_selector("#lf")
        pg.fill("[name=login]", ext); pg.fill("[name=password]", pw); pg.click("#lf button.btn")
        pg.wait_for_selector("#reg.on", timeout=20000)
        log(f"✔ Softphone web {ext} enregistré sur le PBX (WebSocket via Nginx)")
        pages[ext] = pg
    a, b = pages[a_ext], pages[b_ext]
    a.fill("#num", b_ext); a.click("#dial")
    b.wait_for_selector("#answer", timeout=20000)
    log(f"✔ Appel {a_ext} → {b_ext} : le softphone de {b_ext} sonne")
    b.click("#answer")
    a.wait_for_selector("#dur", timeout=20000); b.wait_for_selector("#dur", timeout=20000)
    a.wait_for_timeout(4000)
    state = a.evaluate("""async () => {
      const a = document.querySelector('#remote');
      return { playing: !!a.srcObject && a.srcObject.getAudioTracks().length > 0 };
    }""")
    log(f"✔ En communication des deux côtés (audio reçu : {'oui' if state['playing'] else 'non'})")
    if not state["playing"]:
        raise SystemExit("✖ pas de flux audio reçu")
    a.click("#hang")
    b.wait_for_selector("#dial", timeout=10000)
    log("✔ Raccroché proprement")
    browser.close()
