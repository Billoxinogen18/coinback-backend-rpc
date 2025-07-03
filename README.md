# Coinback RPC Backend

Backend service for Coinback RPC, handling user authentication, rewards calculation, and RPC configurations.

## Features

- User authentication with SIWE (Sign-In with Ethereum)
- RPC configuration management
- Rewards tracking and calculation
- Staking functionality

## Setup

### Prerequisites

- Node.js v16+
- PostgreSQL database

### Installation

1. Clone the repository
```bash
git clone https://github.com/your-username/coinback-backend.git
cd coinback-backend
```

2. Install dependencies
```bash
npm install
```

3. Set up environment variables
Create a `.env` file with the following variables:
```
DATABASE_URL=postgres://user:password@localhost:5432/coinback
JWT_SECRET=your_jwt_secret
PORT=3000
RPC_URL=https://your-sepolia-rpc-endpoint
```

4. Run database migrations
```bash
./run_db_migration.sh
```

5. Start the server
```bash
npm start
```

## API Endpoints

### Authentication
- `POST /api/users/nonce` - Get a nonce for SIWE authentication
- `POST /api/users/verify` - Verify SIWE signature
- `GET /api/users/profile` - Get user profile

### RPC
- `GET /api/rpc/status` - Get RPC status
- `POST /api/rpc/configure` - Configure RPC

### Rewards
- `GET /api/rewards/status` - Get rewards status
- `POST /api/rewards/claim` - Claim rewards

## Deployment

The backend is designed to be deployed on AWS ECS with a PostgreSQL RDS database. 