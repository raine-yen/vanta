-- Store the source's actual binary outcome labels. This keeps head-to-head
-- markets understandable while internal settlement continues to use yes/no.
alter table if exists prediction_markets
  add column if not exists yes_label text,
  add column if not exists no_label text;
