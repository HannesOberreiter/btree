CREATE OR REPLACE VIEW queen_current_placements AS
SELECT
    q.id AS queen_id,
    p.id AS placement_id,
    IF(
        p.to_date = '9999-12-31'
        OR q.modus = 0,
        p.hive_id,
        NULL
    ) AS hive_id,
    IF(
        p.to_date = '9999-12-31'
        OR q.modus = 0,
        p.from_date,
        p.to_date
    ) AS move_date
FROM
    queens q
    LEFT JOIN queen_placements p ON p.id = (
        SELECT
            p2.id
        FROM
            queen_placements p2
        WHERE
            p2.queen_id = q.id
        ORDER BY
            p2.from_date DESC,
            p2.id DESC
        LIMIT
            1
    )
