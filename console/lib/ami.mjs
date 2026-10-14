/**
 * Client AMI (Asterisk Manager Interface) minimal : connexion, authentification, commandes CLI.
 * Une seule connexion réutilisée ; reconnexion automatique à la prochaine commande si elle tombe.
 */
import net from "node:net";

export class Ami {
  constructor({ host, port, user, secret, timeoutMs = 5000 }) {
    Object.assign(this, { host, port, user, secret, timeoutMs });
    this.sock = null;
    this.buf = "";
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const fail = (err) => { this.close(); reject(err); };
      sock.setEncoding("utf8");
      sock.once("error", fail);
      sock.setTimeout(this.timeoutMs, () => fail(new Error("AMI : délai dépassé")));
      let greeted = false;
      sock.on("data", (chunk) => {
        if (!greeted) {
          // Bannière « Asterisk Call Manager/x.y » sur une ligne
          const nl = chunk.indexOf("\n");
          if (nl < 0) return;
          greeted = true;
          chunk = chunk.slice(nl + 1);
          sock.setTimeout(0);
          this.sock = sock;
          this.send({ Action: "Login", Username: this.user, Secret: this.secret, Events: "off" })
            .then((r) => (r.Response === "Success" ? resolve() : fail(new Error(`AMI : connexion refusée (${r.Message || "?"})`))))
            .catch(fail);
        }
        this.onData(chunk);
      });
      sock.on("close", () => this.close(new Error("AMI : connexion fermée")));
    });
    return this.ready;
  }

  close(err) {
    for (const p of this.pending.values()) p.reject(err || new Error("AMI fermé"));
    this.pending.clear();
    if (this.sock) this.sock.destroy();
    this.sock = null;
    this.ready = null;
    this.buf = "";
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\r\n\r\n")) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 4);
      const msg = { _output: [] };
      for (const line of block.split("\r\n")) {
        const c = line.indexOf(":");
        if (c < 0) { if (line) msg._output.push(line); continue; }
        const k = line.slice(0, c), v = line.slice(c + 1).replace(/^ /, "");
        if (k === "Output") msg._output.push(v);
        else msg[k] = v;
      }
      const p = msg.ActionID && this.pending.get(msg.ActionID);
      if (p) { this.pending.delete(msg.ActionID); p.resolve(msg); }
    }
  }

  send(fields) {
    const id = `pbxm-${++this.seq}`;
    const payload = Object.entries({ ...fields, ActionID: id }).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error("AMI : pas de réponse")); }, this.timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.sock.write(payload);
    });
  }

  /** Commande CLI Asterisk ; renvoie les lignes de sortie. */
  async command(cmd) {
    await this.connect();
    const r = await this.send({ Action: "Command", Command: cmd });
    if (r.Response === "Error") throw new Error(`AMI : ${r.Message || "erreur"}`);
    return r._output;
  }
}
