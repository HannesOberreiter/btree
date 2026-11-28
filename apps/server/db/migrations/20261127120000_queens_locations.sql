CREATE OR REPLACE VIEW queens_locations AS
SELECT
    hives.id AS hive_id,
    hives.name AS hive_name,
    q.name AS queen_name,
    q.modus AS queen_modus,
    qp.from_date AS queen_move_date,
    q.modus_date AS queen_modus_date,
    q.mark_colour AS queen_mark_colour,
    q.id AS queen_id
FROM
    queen_placements qp
    INNER JOIN hives ON hives.id = qp.hive_id
    INNER JOIN queens q ON q.id = qp.queen_id
WHERE
    -- The last placement in the hive of a queen that is not deleted. The
    -- subquery reads the hive of `qp`, so that a join on `queen_id` or on
    -- `hive_id` uses the indexes of `queen_placements`.
    qp.id = (
        SELECT
            p.id
        FROM
            queen_placements p
            INNER JOIN queens pq ON pq.id = p.queen_id
            AND pq.deleted = 0
        WHERE
            p.hive_id = qp.hive_id
        ORDER BY
            p.from_date DESC,
            p.id DESC
        LIMIT
            1
    )
    AND hives.deleted = 0
    AND hives.modus = 1
    AND (
        qp.to_date = '9999-12-31'
        OR (
            q.modus = 0
            AND qp.to_date = q.modus_date
        )
    )
