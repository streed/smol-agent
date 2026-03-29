"""Health check routes."""

from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
async def health_check():
    """Health check endpoint.

    Returns:
        dict: Health status with OK status and timestamp.
    """
    from datetime import datetime, timezone

    return {
        "status": "OK",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }