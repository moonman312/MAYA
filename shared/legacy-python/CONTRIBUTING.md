# Contributing to MAYA

Thank you for considering contributing to MAYA! This document provides guidelines and instructions for contributing.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/your-org/maya.git
cd maya

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## Running Tests

```bash
python -m pytest tests/ -v
```

All tests must pass before submitting a pull request.

## Code Style

- Follow PEP 8 conventions
- Use type hints for all function signatures
- Write docstrings for public functions and classes
- Keep functions focused and under 50 lines where possible

## Pull Request Process

1. Fork the repository and create a feature branch
2. Write or update tests for your changes
3. Ensure all tests pass locally
4. Update documentation if needed
5. Submit a PR with a clear description of your changes

## Reporting Issues

When reporting a bug, please include:
- Python version
- Operating system
- Steps to reproduce
- Expected vs actual behavior

## Architecture Guidelines

- **No circular imports** &mdash; follow the dependency hierarchy: `config` &rarr; `models` &rarr; `db` / `utils` &rarr; `etl` / `metrics` &rarr; `rules_engine` &rarr; `scheduler`
- **Multi-tenant isolation** &mdash; all database queries must be scoped by `hotel_id`
- **Pure functions first** &mdash; separate logic from I/O where possible (see `tools/local_gui.py` for examples)
