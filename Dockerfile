FROM node:18-slim

# Install Python + pip + system tools
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv curl unzip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies in a virtual environment
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

# Install Node dependencies
COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
