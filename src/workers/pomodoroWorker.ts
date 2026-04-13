// pomodoroWorker.ts — Web Worker para el tick del Pomodoro
// Corre en un hilo separado para que el timer no sea afectado por el main thread

let intervalId: ReturnType<typeof setInterval> | null = null;
let secondsLeft = 0;

self.onmessage = (e: MessageEvent<{ type: "start" | "stop"; seconds?: number }>) => {
  if (e.data.type === "start") {
    // Clear previous interval if any
    if (intervalId !== null) {
      clearInterval(intervalId);
    }

    secondsLeft = e.data.seconds ?? 0;

    intervalId = setInterval(() => {
      secondsLeft -= 1;
      self.postMessage({ type: "tick" });

      if (secondsLeft <= 0) {
        if (intervalId !== null) {
          clearInterval(intervalId);
        }
        intervalId = null;
        self.postMessage({ type: "complete" });
      }
    }, 1000);
  }

  if (e.data.type === "stop") {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }
};
