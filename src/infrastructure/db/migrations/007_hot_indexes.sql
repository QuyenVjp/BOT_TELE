-- Migration 007 — pilot hot paths (T169/T170).
--
-- Composite indexes match the exact keyset/history and deterministic asset
-- claim order. Text-search expression indexes remove leading-wildcard scans
-- while preserving accent-folded word-prefix search.

create index if not exists order_history_customer_created_idx
  on "order" (customer_id, created_at desc, id desc);

create index if not exists digital_asset_claim_idx
  on digital_asset (variant_id, status, created_at asc, id asc);

create index if not exists product_name_search_idx
  on product using gin (
    to_tsvector(
      'simple',
      translate(
        lower(name_vi),
        'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ',
        'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
      )
    )
  );

create index if not exists category_name_search_idx
  on category using gin (
    to_tsvector(
      'simple',
      translate(
        lower(name_vi),
        'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ',
        'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
      )
    )
  );

create index if not exists product_alias_search_idx
  on product_alias using gin (
    to_tsvector(
      'simple',
      translate(
        lower(normalized_alias),
        'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ',
        'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
      )
    )
  );
