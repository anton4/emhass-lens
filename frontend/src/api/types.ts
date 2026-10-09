import type { components } from './schema'

type S = components['schemas']

export type StatusInfo = S['StatusInfo']
export type ComponentStatus = S['ComponentStatus']
export type VersionInfo = S['VersionInfo']
export type LogEntry = S['LogEntry']
export type JobInfo = S['JobInfo']
export type RunSummary = S['RunSummary']
export type RunDetail = S['RunDetail']
export type ArtifactInfo = S['ArtifactInfo']
export type SettingsResponse = S['SettingsResponse']
export type SettingsDoc = S['Settings']
export type SaveResponse = S['SaveResponse']
export type Revision = S['Revision']
export type DiffEntry = S['DiffEntry']
export type ImportPreview = S['ImportPreview']

export interface FieldError {
  loc: string
  msg: string
}
