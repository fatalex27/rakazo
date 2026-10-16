FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /voice
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY download_models.py .
RUN python download_models.py
COPY server.py .
USER 65534:65534
ENV OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
EXPOSE 8000
CMD ["python", "server.py"]
