-- Runs once when the Docker volume is first created.
-- Tests get their own database because they wipe it before every test.
create database upi_test;
