{{/*
Generate the full name for resources.
*/}}
{{- define "sandbox.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "sandbox.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
open-inspect/sandbox-id: {{ .Values.sandbox.sandboxId | quote }}
open-inspect/session-id: {{ .Values.sandbox.sessionId | quote }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "sandbox.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
