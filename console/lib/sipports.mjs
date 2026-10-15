/**
 * Port SIP du PBX (console : Sécurité › Port SIP) : 5060 par défaut ou 5160.
 * Pendant une transition, les deux ports sont ouverts (both) ; les appareils reçoivent le nouveau port.
 * Le fichier /etc/pbxmaison/sip-ports est écrit par pbx-configure (root) et lu ici.
 */
import path from "node:path";
import { ETC, readEnvFile } from "./config.mjs";

export function sipPorts() {
  let e = {};
  try { e = readEnvFile(path.join(ETC, "sip-ports")); } catch { /* pas encore réglé : 5060 */ }
  const port = String(e.SIP_PORT) === "5160" ? 5160 : 5060;
  const both = String(e.SIP_BOTH) === "1";
  const other = port === 5160 ? 5060 : 5160;
  return { port, tls: port + 1, both, other, other_tls: other + 1 };
}
