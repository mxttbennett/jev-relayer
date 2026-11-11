export const notifyCommand = (message, title = "jev-relayer") => [
  "osascript",
  "-e", "on run argv",
  "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
  "-e", "end run",
  message,
  title,
];

export const isChange = (prev, next) => !prev || prev.model !== next.model || prev.placement !== next.placement;

function titleFromTranscript(text) {
  const hit = text.split("\n").reverse().find((line) => line.includes('"ai-title"'));
  try {
    return hit ? JSON.parse(hit).aiTitle ?? "" : "";
  } catch {
    return "";
  }
}

export const transcriptPath = ({ configDir, cwd, id }) =>
  `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${id}.jsonl`;

export async function sendNotification({ message, readTranscript, run }) {
  const text = await Promise.resolve().then(readTranscript).catch(() => "");
  const title = titleFromTranscript(String(text));
  await Promise.resolve()
    .then(() => run(notifyCommand(message, title || "jev-relayer")))
    .catch(() => {});
}
