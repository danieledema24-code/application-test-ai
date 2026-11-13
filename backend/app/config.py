"""Platform configuration (pydantic-settings). Values come from the environment or `backend/.env`."""

from __future__ import annotations

import base64
import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEV_SECRET_KEY = "dev-insecure-secret-key-change-me"  # noqa: S105 - placeholder refused in production


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    app_version: str = "0.1.0"
    log_level: str = "INFO"
    log_json: bool = True

    database_url: str = f"sqlite+aiosqlite:///{BACKEND_DIR / 'data' / 'qa.db'}"
    storage_dir: Path = BACKEND_DIR / "data" / "storage"

    secret_key: SecretStr = SecretStr(DEV_SECRET_KEY)
    # 32 random bytes, base64. Optional outside production (derived from SECRET_KEY there).
    encryption_key: SecretStr | None = None
    encryption_key_id: str = "k1"

    web_origin: str = "http://localhost:3002"
    public_api_url: str = "http://localhost:8200"

    # Dev/test only: lets the scanner reach the *approved target* on a private/loopback address.
    allow_private_targets: bool = False

    worker_mode: Literal["inline", "separate", "off"] = "inline"
    worker_concurrency: int = 2
    worker_poll_interval_s: float = 0.5
    job_heartbeat_timeout_s: int = 60

    ai_provider: Literal["auto", "claude", "disabled"] = "auto"
    anthropic_api_key: SecretStr | None = None
    ai_model: str = "claude-opus-5-5"
    ai_max_output_tokens: int = 8000
    ai_timeout_s: float = 120.0

    # Discovery limits (lead decisions: default 30 / max 100 pages, 20 min, 2 concurrent per org).
    scan_default_max_pages: int = 30
    scan_max_pages_cap: int = 100
    scan_default_max_depth: int = 3
    scan_time_limit_s: int = 20 * 60
    scan_page_timeout_s: int = 20
    scan_politeness_delay_ms: int = 500
    scan_mobile_sample_pages: int = 10
    scan_max_dom_bytes: int = 2 * 1024 * 1024
    max_concurrent_scans_per_org: int = 2

    session_ttl_hours: int = 12
    signed_url_ttl_s: int = 15 * 60
    sse_max_connection_s: int = 30 * 60
    sse_poll_interval_s: float = 0.5
    sse_keepalive_s: float = 15.0

    # Rate limits (per process, in memory).
    rl_login_failures: int = 10
    rl_login_window_s: int = 600
    rl_register_per_hour: int = 5
    rl_url_check_per_min: int = 30
    rl_project_create_per_hour: int = 20
    rl_stage_runs_per_hour: int = 10
    rl_api_per_min: int = 600

    url_check_timeout_s: float = 10.0
    url_check_max_redirects: int = 5

    browser_headless: bool = True
    pool_max_contexts: int = 4

    extra_test_origins: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _production_guards(self) -> Settings:
        if self.env == "production":
            if self.allow_private_targets:
                raise ValueError("ALLOW_PRIVATE_TARGETS must not be enabled when ENV=production")
            if self.secret_key.get_secret_value() == DEV_SECRET_KEY or len(self.secret_key.get_secret_value()) < 32:
                raise ValueError("SECRET_KEY must be set to a random value of at least 32 characters in production")
            if self.encryption_key is None:
                raise ValueError("ENCRYPTION_KEY is required in production")
        if self.scan_default_max_pages > self.scan_max_pages_cap:
            raise ValueError("SCAN_DEFAULT_MAX_PAGES cannot exceed SCAN_MAX_PAGES_CAP")
        return self

    def encryption_key_bytes(self) -> bytes:
        if self.encryption_key is not None:
            key = base64.b64decode(self.encryption_key.get_secret_value())
            if len(key) != 32:
                raise ValueError("ENCRYPTION_KEY must be 32 bytes, base64 encoded")
            return key
        return hashlib.sha256(b"encryption:" + self.secret_key.get_secret_value().encode()).digest()

    @property
    def ai_enabled(self) -> bool:
        if self.ai_provider == "disabled":
            return False
        return self.anthropic_api_key is not None and bool(self.anthropic_api_key.get_secret_value())

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()
