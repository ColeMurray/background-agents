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
{{- $sandbox := (get .Values "sandbox") | default dict -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
open-inspect/sandbox-id: {{ get $sandbox "sandboxId" | default "" | quote }}
open-inspect/session-id: {{ get $sandbox "sessionId" | default "" | quote }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "sandbox.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
