int classify(int value) {
  switch (value) {
  case 0:
    return 0;
  case 1:
    int doubled = value * 2;
  case 2:
    return doubled;
  }
  if (value = 3) {
    goto finish;
  }
  int result = value;
finish:
  return result;
}

int sign(int value) {
  if (value > 0)
    return 1;
  else if (value < 0)
    return -1;
}

int main() {
  return classify(1) + sign(-2);
}
