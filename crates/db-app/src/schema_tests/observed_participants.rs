use super::*;

#[tokio::test]
async fn participant_observation_timestamps_are_additive_and_nullable() {
    let migration = APP_MIGRATION_STEPS
        .iter()
        .find(|step| step.id == "20260830100000_session_participant_observation")
        .expect("participant observation migration");
    assert_eq!(
        migration.scope,
        anlg_db_migrate::MigrationScope::CloudsyncAlter {
            table_name: "session_participants",
        }
    );

    let db = test_db().await;
    sqlx::query("INSERT INTO sessions (id) VALUES ('session-1')")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO session_participants (id, session_id, display_name, source)
         VALUES ('participant-1', 'session-1', 'Ada Lovelace', 'observed')",
    )
    .execute(db.pool())
    .await
    .unwrap();

    let observation: (Option<String>, Option<String>, String) = sqlx::query_as(
        "SELECT first_observed_at, last_observed_at, metadata_json
         FROM session_participants WHERE id = 'participant-1'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(observation, (None, None, "{}".to_string()));
}
