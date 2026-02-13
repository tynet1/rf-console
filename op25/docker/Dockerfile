FROM scresante/op25-docker@sha256:838e88e4bd84941384877699c4d71f194386c33b73b7f90383ea4a13a83e2754

COPY op25_container_runner.py /runner/op25_container_runner.py
RUN chmod +x /runner/op25_container_runner.py \
  && python3 -m py_compile /runner/op25_container_runner.py

ENTRYPOINT ["python3", "/runner/op25_container_runner.py"]
