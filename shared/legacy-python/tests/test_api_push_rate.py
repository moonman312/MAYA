"""Tests for MewsApiClient.push_rate_update()."""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
import requests

from api_client import MewsApiClient
from models import Hotel


@pytest.fixture
def hotel():
    return Hotel(
        id=1, name="Test Hotel",
        client_token="ct", access_token="at",
        enterprise_id="eid",
        base_url="https://api.mews-demo.com/api/connector/v1",
    )


@pytest.fixture
def client(hotel):
    return MewsApiClient(hotel)


class TestPushRateUpdate:
    @patch("api_client.requests.post")
    def test_success(self, mock_post, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"RateId": "r123"}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        result = client.push_rate_update(
            rate_plan_id="rp1",
            space_category_id="sc1",
            start_utc="2026-06-01T00:00:00Z",
            end_utc="2026-06-02T00:00:00Z",
            amount=199.99,
        )
        assert result == {"RateId": "r123"}

        # Verify the payload structure
        call_args = mock_post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert payload["ClientToken"] == "ct"
        assert payload["AccessToken"] == "at"
        assert payload["RatePlanId"] == "rp1"
        assert payload["SpaceCategoryId"] == "sc1"
        assert payload["Amount"]["GrossValue"] == 199.99
        assert payload["Amount"]["Currency"] == "USD"

    @patch("api_client.requests.post")
    def test_custom_currency(self, mock_post, client):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        client.push_rate_update(
            rate_plan_id="rp1",
            space_category_id="sc1",
            start_utc="2026-06-01T00:00:00Z",
            end_utc="2026-06-02T00:00:00Z",
            amount=150.0,
            currency="EUR",
        )
        payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
        assert payload["Amount"]["Currency"] == "EUR"

    @patch("api_client.requests.post")
    def test_http_error_raises(self, mock_post, client):
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = requests.exceptions.HTTPError("500")
        mock_post.return_value = mock_resp

        with pytest.raises(requests.exceptions.HTTPError):
            client.push_rate_update(
                rate_plan_id="rp1",
                space_category_id="sc1",
                start_utc="2026-06-01T00:00:00Z",
                end_utc="2026-06-02T00:00:00Z",
                amount=100.0,
            )

    @patch("api_client.requests.post")
    def test_url_construction(self, mock_post, client):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {}
        mock_resp.raise_for_status.return_value = None
        mock_post.return_value = mock_resp

        client.push_rate_update(
            rate_plan_id="rp1",
            space_category_id="sc1",
            start_utc="2026-06-01T00:00:00Z",
            end_utc="2026-06-02T00:00:00Z",
            amount=100.0,
        )
        call_args = mock_post.call_args
        url = call_args[0][0] if call_args[0] else call_args.kwargs.get("url")
        assert url.endswith("/rates/addRate")
