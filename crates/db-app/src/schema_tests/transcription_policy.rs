use super::*;

#[tokio::test]
async fn transcription_policy_columns_are_additive_and_preserve_legacy_language() {
    for (id, table_name) in [
        ("20260829100000_session_transcription_policy", "sessions"),
        (
            "20260829100100_transcript_transcription_target",
            "transcripts",
        ),
    ] {
        let migration = APP_MIGRATION_STEPS
            .iter()
            .find(|step| step.id == id)
            .expect("transcription target migration");
        assert_eq!(
            migration.scope,
            anlg_db_migrate::MigrationScope::CloudsyncAlter { table_name }
        );
    }

    let db = test_db().await;
    sqlx::query("INSERT INTO sessions (id) VALUES ('session-1')")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO transcripts (id, session_id) VALUES ('transcript-1', 'session-1')")
        .execute(db.pool())
        .await
        .unwrap();

    let session_policy: (String, String, String) = sqlx::query_as(
        "SELECT transcription_provider, transcription_model, transcription_languages_json
         FROM sessions WHERE id = 'session-1'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(
        session_policy,
        (String::new(), String::new(), "[\"en\"]".into())
    );

    let transcript_target: (String, String) = sqlx::query_as(
        "SELECT requested_languages_json, provider_model
         FROM transcripts WHERE id = 'transcript-1'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(transcript_target, ("[]".into(), String::new()));
}
