// Dashboard.tsx — Pantalla principal de StudyAI (placeholder)
// Se muestra cuando Canvas ya está configurado correctamente

interface DashboardProps {
  /** Callback para ir a la pantalla de configuración */
  onGoToSettings?: () => void;
}

export function Dashboard({ onGoToSettings }: DashboardProps) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-md">
        <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-6">
          <span className="text-2xl">📚</span>
        </div>
        <h1 className="text-3xl font-bold text-white">StudyAI</h1>
        <p className="text-gray-400">
          Tu asistente de estudio universitario
        </p>

        <div className="flex items-center justify-center gap-2 mt-4">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-green-400 text-sm">Canvas conectado</span>
        </div>

        <p className="text-gray-600 text-sm mt-8">
          Dashboard en construcción — próximas semanas 🚧
        </p>

        {/* Botón para volver a configuración si se necesita */}
        <button
          onClick={onGoToSettings}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors mt-4 underline"
        >
          Cambiar configuración de Canvas
        </button>
      </div>
    </div>
  );
}

export default Dashboard;
