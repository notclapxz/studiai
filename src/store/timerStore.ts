// timerStore.ts — Estado global del Pomodoro timer con Zustand
// Gestiona el ciclo focus/break, segundos restantes, y conexión con el Web Worker

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export type TimerPhase = "idle" | "focus" | "break";

interface TimerState {
  // ─── Estado del timer ───────────────────────────────────────────────────────
  phase: TimerPhase;
  secondsLeft: number;
  cycles: number;
  isRunning: boolean;

  // ─── Configuración cargada desde SQLite ─────────────────────────────────────
  focusMinutes: number;
  breakMinutes: number;

  // ─── Worker reference (no serializable → guardado fuera del estado reactive) ─
  // El worker se guarda en un ref externo, no en el store.

  // ─── Acciones ───────────────────────────────────────────────────────────────
  loadSettings: () => Promise<void>;
  start: () => void;
  pause: () => void;
  reset: () => void;
  tick: () => void;
  completePhase: () => void;
}

// Worker singleton outside the store (not serializable)
let worker: Worker | null = null;

function getWorker(onTick: () => void, onComplete: () => void): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/pomodoroWorker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent<{ type: "tick" | "complete" }>) => {
    if (e.data.type === "tick") onTick();
    if (e.data.type === "complete") onComplete();
  };
  return worker;
}

function destroyWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

async function sendPomodoroNotification(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    if (granted) {
      sendNotification({ title, body });
    }
    } catch {
      // Ignore notification errors — non-critical
    }
}

export const useTimerStore = create<TimerState>((set, get) => ({
  phase: "idle",
  secondsLeft: 25 * 60,
  cycles: 0,
  isRunning: false,
  focusMinutes: 25,
  breakMinutes: 5,

  loadSettings: async () => {
    try {
      const [focusRaw, breakRaw] = await Promise.all([
        invoke<string | null>("get_setting", { key: "pomodoro_focus_minutes" }),
        invoke<string | null>("get_setting", { key: "pomodoro_break_minutes" }),
      ]);
      const focusMinutes = focusRaw ? parseInt(focusRaw, 10) || 25 : 25;
      const breakMinutes = breakRaw ? parseInt(breakRaw, 10) || 5 : 5;
      const { phase } = get();
      set({
        focusMinutes,
        breakMinutes,
        // Actualizar secondsLeft solo si está en idle (no interrumpir timer activo)
        secondsLeft: phase === "idle" ? focusMinutes * 60 : get().secondsLeft,
      });
    } catch {
      // Use defaults if read fails
    }
  },

  start: () => {
    const state = get();
    if (state.isRunning) return;

    // Si está idle, iniciar fase focus
    if (state.phase === "idle") {
      set({ phase: "focus", secondsLeft: state.focusMinutes * 60, isRunning: true });
    } else {
      set({ isRunning: true });
    }

    const w = getWorker(
      () => get().tick(),
      () => get().completePhase(),
    );
    w.postMessage({ type: "start", seconds: get().secondsLeft });
  },

  pause: () => {
    set({ isRunning: false });
    if (worker) worker.postMessage({ type: "stop" });
  },

  reset: () => {
    destroyWorker();
    const { focusMinutes } = get();
    set({ phase: "idle", secondsLeft: focusMinutes * 60, isRunning: false, cycles: 0 });
  },

  tick: () => {
    const { secondsLeft } = get();
    if (secondsLeft > 0) {
      set({ secondsLeft: secondsLeft - 1 });
    }
  },

  completePhase: () => {
    destroyWorker();
    const { phase, cycles, focusMinutes, breakMinutes } = get();

    if (phase === "focus") {
      const newCycles = cycles + 1;
      set({ phase: "break", secondsLeft: breakMinutes * 60, cycles: newCycles, isRunning: false });
      sendPomodoroNotification("¡Tiempo de descanso!", `Completaste ${newCycles} ciclo${newCycles !== 1 ? "s" : ""}. Tómate un respiro.`);
    } else if (phase === "break") {
      set({ phase: "idle", secondsLeft: focusMinutes * 60, isRunning: false });
      sendPomodoroNotification("¡A trabajar!", "El descanso terminó. ¿Listo para el siguiente ciclo?");
    }
  },
}));
