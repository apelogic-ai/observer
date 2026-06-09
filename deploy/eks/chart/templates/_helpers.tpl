{{/* Common name/label helpers. */}}

{{- define "observer-ingestor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "observer-ingestor.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "observer-ingestor.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "observer-ingestor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "observer-ingestor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "observer-ingestor.labels" -}}
helm.sh/chart: {{ include "observer-ingestor.chart" . }}
{{ include "observer-ingestor.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "observer-ingestor.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "observer-ingestor.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Fully-qualified image ref. Fails closed when no image is pinned. */}}
{{- define "observer-ingestor.image" -}}
{{- $repo := required "image.repository is required — pin an image from a trusted registry" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- $tag := required "image.tag or image.digest is required" .Values.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret supplying OBSERVER_API_KEYS. Fails closed: the deployer
must either reference an existing Secret or enable the ExternalSecret. The
key value is never read from chart values.
*/}}
{{- define "observer-ingestor.secretName" -}}
{{- if .Values.externalSecret.enabled -}}
{{- include "observer-ingestor.fullname" . -}}
{{- else -}}
{{- required "Provide secret.existingSecret or enable externalSecret — OBSERVER_API_KEYS must come from a Secret, never from values" .Values.secret.existingSecret -}}
{{- end -}}
{{- end -}}
