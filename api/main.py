"""FastAPI application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import health

# Create FastAPI application
app = FastAPI(
    title="smol-agent API",
    description="Backend API for smol-agent",
    version="0.1.0",
)

# Configure CORS middleware for frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router, prefix="/api")


@app.get("/")
async def root():
    """Root endpoint redirect to health check.

    Returns:
        dict: Basic info about the API.
    """
    return {"message": "smol-agent API", "docs": "/docs"}