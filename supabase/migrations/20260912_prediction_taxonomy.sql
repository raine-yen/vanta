-- Discovery taxonomy for prediction markets: store the parent event slug and
-- the Gamma tag list so the Sports/Esports discovery categories work even when
-- market questions don't contain sport keywords. Idempotent.

alter table if exists prediction_markets add column if not exists event_slug text;
alter table if exists prediction_markets add column if not exists tags jsonb;

create index if not exists idx_prediction_markets_tags on prediction_markets using gin (tags jsonb_path_ops);
