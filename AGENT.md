# AGENT.md - Guidelines for this codebase

## Execution Commands
- Start bot in polling mode: `node bot.js`
- Deploy bot with webhook: Set `RENDER_EXTERNAL_URL` and `BOT_TOKEN` environment variables

## Code Style Guidelines

### Imports & Modules
- CommonJS module system (require/module.exports)
- Group related imports together
- Third-party modules first, then local modules

### Error Handling
- Use try/catch blocks for async operations
- Log errors with console.error() and include context
- Return appropriate error messages to users

### Naming Conventions
- camelCase for variables and functions
- Clear descriptive names (e.g., processUserQuery, markdownToHTML)
- Async functions should be prefixed with async keyword

### Formatting
- Use 2-space indentation
- Use consistent promise-based approach with async/await
- Add comments for complex logic
- Include timeouts and retries for external API calls

### Environment
- Use dotenv for environment variables
- Check for required env variables at startup