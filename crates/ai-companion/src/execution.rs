use crate::{App, oauth};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

pub struct ExecutionError(StatusCode, &'static str);

impl IntoResponse for ExecutionError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "message": self.1 }))).into_response()
    }
}

fn failed() -> ExecutionError {
    ExecutionError(
        StatusCode::BAD_GATEWAY,
        "ChatGPT could not complete this request. Try again.",
    )
}

async fn access_token(app: &App) -> Result<String, ExecutionError> {
    let runtime = app.runtime.lock().await;
    runtime
        .record
        .tokens
        .as_ref()
        .filter(|tokens| tokens.expires_at > oauth::now() && runtime.pending.is_none())
        .map(|tokens| tokens.access_token.clone())
        .ok_or(ExecutionError(
            StatusCode::UNAUTHORIZED,
            "Connect ChatGPT in Settings before using AI.",
        ))
}

// Only the isolated debug authorization fixture can replace the provider.
fn endpoint(app: &App, path: &str) -> String {
    if cfg!(debug_assertions) && app.issuer != "https://auth.openai.com" {
        format!("{}/v1/{path}", app.issuer)
    } else {
        format!("https://api.openai.com/v1/{path}")
    }
}

async fn check_response(
    app: &App,
    token: &str,
    response: reqwest::Response,
) -> Result<reqwest::Response, ExecutionError> {
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let mut runtime = app.runtime.lock().await;
        if let Some(tokens) = runtime
            .record
            .tokens
            .as_mut()
            .filter(|tokens| tokens.access_token == token)
        {
            tokens.expires_at = 0;
            let _ = runtime.vault.save(&runtime.record);
        }
        return Err(ExecutionError(
            StatusCode::UNAUTHORIZED,
            "ChatGPT needs reconnection. Connect again in Settings.",
        ));
    }
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(ExecutionError(
            StatusCode::TOO_MANY_REQUESTS,
            "ChatGPT usage is temporarily limited. Try again later.",
        ));
    }
    if !response.status().is_success() {
        return Err(failed());
    }
    Ok(response)
}

#[derive(Deserialize, Serialize)]
pub struct Model {
    slug: String,
    display_name: String,
    visibility: String,
}

#[derive(Deserialize, Serialize)]
pub struct Models {
    models: Vec<Model>,
}

pub async fn models(State(app): State<App>) -> Result<Json<Models>, ExecutionError> {
    let token = access_token(&app).await?;
    let response = app
        .http
        .get(endpoint(&app, "models"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| failed())?;
    let mut result: Models = check_response(&app, &token, response)
        .await?
        .json()
        .await
        .map_err(|_| failed())?;
    result.models.retain(|model| model.visibility == "list");
    Ok(Json(result))
}

// A workflow supplies its own instructions and input; authentication and the
// provider's streaming protocol stay inside this reusable execution boundary.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequest {
    model: String,
    instructions: String,
    input: String,
}

pub async fn execute(
    State(app): State<App>,
    Json(request): Json<ExecutionRequest>,
) -> Result<Json<Value>, ExecutionError> {
    if request.model.trim().is_empty()
        || request.model.len() > 200
        || request.instructions.len() > 64_000
        || request.input.trim().is_empty()
        || request.input.len() > 64_000
    {
        return Err(ExecutionError(
            StatusCode::BAD_REQUEST,
            "Provide a model and instructions within the request limits.",
        ));
    }
    let token = access_token(&app).await?;
    let response = app
        .http
        .post(endpoint(&app, "responses"))
        .bearer_auth(&token)
        .timeout(Duration::from_secs(180))
        .json(&json!({
            "model": request.model,
            "instructions": request.instructions,
            "input": [{ "role": "user", "content": request.input }],
            "store": false,
            "stream": true,
        }))
        .send()
        .await
        .map_err(|_| failed())?;
    let mut response = check_response(&app, &token, response).await?;
    let mut pending = Vec::new();
    let mut data = String::new();
    let mut streamed_text = String::new();
    let mut received = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| failed())? {
        received += chunk.len();
        if received > 2_000_000 {
            return Err(failed());
        }
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| failed())?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() && !data.is_empty() {
                let event: Value = serde_json::from_str(&data).map_err(|_| failed())?;
                data.clear();
                match event["type"].as_str() {
                    Some("response.output_text.delta") => {
                        streamed_text.push_str(event["delta"].as_str().ok_or_else(failed)?);
                    }
                    Some("response.refusal.delta" | "response.refusal.done") => {
                        return Err(ExecutionError(
                            StatusCode::BAD_GATEWAY,
                            "ChatGPT declined this request. Adjust your instructions and try again.",
                        ));
                    }
                    Some("response.completed") => {
                        if event["response"]["status"] != "completed" {
                            return Err(failed());
                        }
                        let mut text = String::new();
                        for item in event["response"]["output"].as_array().ok_or_else(failed)? {
                            if item["type"] != "message" {
                                continue;
                            }
                            for content in item["content"].as_array().ok_or_else(failed)? {
                                if content["type"] == "refusal" {
                                    return Err(ExecutionError(
                                        StatusCode::BAD_GATEWAY,
                                        "ChatGPT declined this request. Adjust your instructions and try again.",
                                    ));
                                }
                                if content["type"] == "output_text" {
                                    text.push_str(content["text"].as_str().ok_or_else(failed)?);
                                }
                            }
                        }
                        // Subscription inference may leave output empty in the
                        // terminal snapshot. Retain deltas, but accept them only
                        // after the provider confirms successful completion.
                        if text.is_empty() {
                            text = std::mem::take(&mut streamed_text);
                        }
                        if text.trim().is_empty() {
                            return Err(ExecutionError(
                                StatusCode::BAD_GATEWAY,
                                "ChatGPT completed the request without any text. Try again or select another model.",
                            ));
                        }
                        return Ok(Json(json!({ "text": text })));
                    }
                    Some("response.failed" | "response.incomplete" | "error") => {
                        return Err(failed());
                    }
                    _ => (),
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim_start_matches(' '));
                data.push('\n');
            }
        }
    }
    Err(ExecutionError(
        StatusCode::BAD_GATEWAY,
        "ChatGPT returned an incomplete response. Try again.",
    ))
}
