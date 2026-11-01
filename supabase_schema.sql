-- Habilita extensão de criptografia
create extension if not exists pgcrypto;

-- 1. Tabela de Acervo Interno de Documentos Auditados (Fingerprints de N-Grams)
create table if not exists public.academic_corpus (
  id uuid primary key default gen_random_uuid(),
  document_title text not null,
  institution_name text,
  academic_area text default 'all',
  citation_norm text default 'abnt',
  content_sha256 text unique not null,
  normalized_excerpt text not null,
  word_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- 2. Tabela de Laudos Técnicos Rastreáveis (Com Código de Autenticidade p/ Professores)
create table if not exists public.audit_reports (
  id uuid primary key default gen_random_uuid(),
  verification_code text unique not null,
  document_title text not null,
  total_words integer not null,
  gross_similarity_pct numeric(5,2) not null,
  shielded_normative_pct numeric(5,2) not null,
  net_unreferenced_risk_pct numeric(5,2) not null,
  norm_compliance_score integer not null,
  report_payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_corpus_sha256 on public.academic_corpus(content_sha256);
