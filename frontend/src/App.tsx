import { HashRouter, Route, Routes } from 'react-router'
import { Layout } from './components/Layout'
import { ChargerPage } from './pages/ChargerPage'
import { HealthPage } from './pages/HealthPage'
import { InputsPage } from './pages/InputsPage'
import { InverterPage } from './pages/InverterPage'
import { LogsPage } from './pages/LogsPage'
import { PlanPage } from './pages/PlanPage'
import { RunDetailPage } from './pages/RunDetailPage'
import { RunsPage } from './pages/RunsPage'
import { SettingsPage } from './pages/settings/SettingsPage'

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<PlanPage />} />
          <Route path="inputs" element={<InputsPage />} />
          <Route path="inverter" element={<InverterPage />} />
          <Route path="charger" element={<ChargerPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/:id" element={<RunDetailPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="health" element={<HealthPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<PlanPage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
