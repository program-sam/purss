-- Enclosure addresses synced from the engine were stored HTML-escaped (`&amp;` in a query), which publishers' servers refuse
-- (a download or playback answered 400). Stored addresses get the `&` the feed meant; the sync stores them so from now on.
UPDATE items SET enclosures = replace(enclosures, '&amp;', '&') WHERE enclosures LIKE '%&amp;%';
