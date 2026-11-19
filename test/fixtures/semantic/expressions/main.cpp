int area(int width, int height);
double area(double radius);

int main() {
  const int size = 4;
  int cells[size * 2];
  char small{300};
  int *first = cells;
  double *wrong = first;
  return area(2u, 3) + area(1.5f) + cells[size];
}
