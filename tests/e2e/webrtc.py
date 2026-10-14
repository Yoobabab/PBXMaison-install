"""Appel WebRTC réel entre deux softphones web (Chromium, micro simulé) à travers Nginx et Asterisk,
   puis message laissé sur la messagerie d'un troisième poste (non connecté).
   python3 webrtc.py <base_url> <poste_A> <mdp_A> <poste_B> <mdp_B> [poste_messagerie]"""
import os, sys
from playwright.sync_api import sync_playwright

base, a_ext, a_pw, b_ext, b_pw = sys.argv[1:6]
vm_ext = sys.argv[6] if len(sys.argv) > 6 else ""
mode = sys.argv[7] if len(sys.argv) > 7 else "basic"
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(SHOTS, exist_ok=True)
def log(m): print(m, flush=True)
def shot(pg, name):
    try: pg.screenshot(path=os.path.join(SHOTS, f"{name}.png"))
    except Exception as e: log(f"(capture {name} impossible : {e})")

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
    if mode == "callflow":
        def call_and_answer(number, dtmf=None, label=""):
            a.click("#opendial"); a.fill("#num", number); a.click("#dial")
            if dtmf:
                a.wait_for_selector("#dur", timeout=20000)   # le SVI décroche
                a.wait_for_timeout(2500)
                a.click("#kp"); a.click(f"[data-d='{dtmf}']")
            b.wait_for_selector("#answer", timeout=25000)
            name = b.inner_text(".sp-incoming .cname")
            log(f"✔ {label} : le softphone de {b_ext} sonne (affiché : {name})")
            b.click("#answer"); b.wait_for_selector("#dur", timeout=20000)
            a.wait_for_timeout(2000)
            a.click("#hang"); b.wait_for_selector("#dial", timeout=15000); a.wait_for_timeout(1500)
        call_and_answer("600", label="Groupe 600")
        shot(b, "6-groupe")
        call_and_answer("800", dtmf="1", label="SVI 800, touche 1 → groupe 600")
        log("✔ Gestion d'appels OK")
        browser.close()
        sys.exit(0)
    shot(a, "1-equipe")
    a.click("#opendial"); a.fill("#num", b_ext); a.click("#dial")
    b.wait_for_selector("#answer", timeout=20000)
    log(f"✔ Appel {a_ext} → {b_ext} : le softphone de {b_ext} sonne")
    shot(a, "2-appel-sortant"); shot(b, "3-appel-entrant")
    b.click("#answer")
    a.wait_for_selector("#dur", timeout=20000); b.wait_for_selector("#dur", timeout=20000)
    a.wait_for_timeout(4000)
    shot(a, "4-en-communication")
    state = a.evaluate("""async () => {
      const a = document.querySelector('#remote');
      return { playing: !!a.srcObject && a.srcObject.getAudioTracks().length > 0 };
    }""")
    log(f"✔ En communication des deux côtés (audio reçu : {'oui' if state['playing'] else 'non'})")
    if not state["playing"]:
        raise SystemExit("✖ pas de flux audio reçu")
    a.click("#hang")
    b.wait_for_selector("#dial", timeout=10000)
    a.wait_for_timeout(2000)
    a.goto(f"{base}/softphone#/appels"); a.wait_for_selector(".rows li[data-sel]", timeout=10000)
    shot(a, "5-historique")
    log(f"✔ Historique : appel vers {b_ext} enregistré")
    if vm_ext:
        a.wait_for_selector("#reg.on", timeout=20000)
        a.click("#opendial"); a.fill("#num", vm_ext); a.click("#dial")
        a.wait_for_selector("#dur", timeout=20000)
        a.wait_for_timeout(16000)  # annonce de la messagerie (~8 s) puis enregistrement
        a.click("#hang")
        a.wait_for_timeout(1500)
        log(f"✔ Message laissé sur la messagerie de {vm_ext}")
    log("✔ Raccroché proprement")
    browser.close()
